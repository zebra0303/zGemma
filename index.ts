import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamText } from 'hono/streaming';
import { getLlama, LlamaChatSession } from 'node-llama-cpp';
import * as path from 'path';

// 환경설정 (Bun이 .env를 자동 로드하므로 dotenv 불필요)
function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const config = {
  // gguf 모델 파일 경로 (상대 경로면 실행 디렉터리 기준)
  modelPath: path.resolve(process.cwd(), process.env.MODEL_PATH ?? 'gemma-4-12b-it-Q4_K_M.gguf'),
  // OpenAI 호환 응답에 노출할 모델 id
  modelId: process.env.MODEL_ID ?? 'gemma-4',
  // 16GB RAM에서 안전한 컨텍스트 크기는 4096(4K). 더 긴 입력이 필요하면 최대 8192(8K)까지 타협.
  contextSize: numEnv('CONTEXT_SIZE', 4096),
  // M1 성능 코어 수에 맞춰 빠른 첫 토큰(TTFT) 확보
  threads: numEnv('THREADS', 4),
  // Ollama와 동일한 포트를 써서 에이전트 호환성 극대화
  port: numEnv('PORT', 11434),
};

const app = new Hono();
app.use('*', cors()); // 에이전트 도구들의 크로스 오리진 요청 허용

// Gemma 4의 interleaved-thinking 챗 템플릿은 응답 앞에 빈 thought 채널
// `<|channel>thought\n<channel|>` 스캐폴딩을 붙이는데, node-llama-cpp는 이를
// 파싱하지 못해 마커가 그대로 노출된다. 아래 필터로 스트리밍/논스트리밍 모두에서 제거한다.
const CH_OPEN = '<|channel>';
const CH_CLOSE = '<channel|>';
const CH_MAX = Math.max(CH_OPEN.length, CH_CLOSE.length);

function stripChannelMarkers(s: string): string {
  return s.split(CH_OPEN).join('').split(CH_CLOSE).join('');
}

// 완성된 전체 응답에서 thought 스캐폴딩을 제거하고 최종 답변만 남긴다.
function cleanResponse(text: string): string {
  const idx = text.lastIndexOf(CH_CLOSE);
  const body = idx === -1 ? text : text.slice(idx + CH_CLOSE.length);
  return stripChannelMarkers(body).replace(/^\s+/, '');
}

// 토큰 단위 스트리밍에서도 마커가 새지 않도록 상태를 유지하는 필터.
class ChannelStreamFilter {
  private buf = '';
  private started = false; // thought 스캐폴딩을 지나 본문 구간에 진입했는지

  feed(chunk: string): string {
    this.buf += chunk;

    if (!this.started) {
      if (this.buf.length < CH_OPEN.length) {
        // 아직 여는 마커인지 본문인지 판단할 수 없으면 잠시 보류
        return CH_OPEN.startsWith(this.buf) ? '' : this.passthrough();
      }
      if (!this.buf.startsWith(CH_OPEN)) {
        // 스캐폴딩 없는 일반 응답 → 그대로 통과
        this.started = true;
        return this.passthrough();
      }
      const idx = this.buf.indexOf(CH_CLOSE);
      if (idx === -1) return ''; // thought 채널 종료를 기다린다
      this.started = true;
      this.buf = this.buf.slice(idx + CH_CLOSE.length).replace(/^\s+/, '');
    }
    return this.passthrough();
  }

  // 본문 구간: 완전한 마커는 제거하고, 잘릴 수 있는 끝부분은 다음 청크까지 보류.
  private passthrough(): string {
    let out = stripChannelMarkers(this.buf);
    let hold = 0;
    for (let k = 1; k < CH_MAX && k <= out.length; k++) {
      const tail = out.slice(out.length - k);
      if (CH_OPEN.startsWith(tail) || CH_CLOSE.startsWith(tail)) hold = k;
    }
    const emit = hold > 0 ? out.slice(0, out.length - hold) : out;
    this.buf = hold > 0 ? out.slice(out.length - hold) : '';
    return emit;
  }

  flush(): string {
    const out = stripChannelMarkers(this.buf);
    this.buf = '';
    return out;
  }
}

// 1. 런타임 및 모델 로드
const llama = await getLlama();

console.log(`⏳ 모델 로드 중... (${config.modelPath})`);
const model = await llama.loadModel({ modelPath: config.modelPath });

// 컨텍스트는 요청마다가 아니라 시작 시 한 번만 생성한다.
const context = await model.createContext({
  contextSize: config.contextSize,
  threads: config.threads,
});
console.log('✅ 모델 로드 완료! 서버가 준비되었습니다.');

// 2. OpenAI 호환 가상 모델 목록 엔드포인트
app.get('/v1/models', (c) => {
  return c.json({
    object: 'list',
    data: [{ id: config.modelId, object: 'model', created: Date.now(), owned_by: 'local' }],
  });
});

// 3. 핵심: Chat Completions 엔드포인트
app.post('/v1/chat/completions', async (c) => {
  const { messages, stream, temperature } = await c.req.json();

  // 마지막 유저 메시지 추출
  const userMessage = messages[messages.length - 1]?.content || '';

  // 요청마다 새 시퀀스 + 세션을 만들어 동시 요청 간 상태 충돌을 방지한다.
  const sequence = context.getSequence();
  const evaluator = new LlamaChatSession({ contextSequence: sequence });

  // 스트리밍 응답 처리 (Pi Agent / OpenCode 표준)
  if (stream) {
    return streamText(c, async (serverStream) => {
      c.header('Content-Type', 'text/event-stream');
      c.header('Cache-Control', 'no-cache');
      c.header('Connection', 'keep-alive');

      const chunkId = `chatcmpl-${Math.random().toString(36).substr(2, 9)}`;
      const filter = new ChannelStreamFilter();

      const sendDelta = (content: string) => {
        if (!content) return;
        const payload = {
          id: chunkId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: config.modelId,
          choices: [{ index: 0, delta: { content }, finish_reason: null }],
        };
        serverStream.write(`data: ${JSON.stringify(payload)}\n\n`);
      };

      try {
        await evaluator.prompt(userMessage, {
          temperature,
          onTextChunk: (text) => sendDelta(filter.feed(text)),
        });

        sendDelta(filter.flush()); // 보류 중이던 잔여 텍스트 방출
        // 스트림 종료 신호
        serverStream.write('data: [DONE]\n\n');
      } finally {
        sequence.dispose(); // 시퀀스 슬롯 반환
      }
    });
  }

  // 단발성 비스트리밍 응답 처리
  let responseText: string;
  try {
    responseText = await evaluator.prompt(userMessage, { temperature });
  } finally {
    sequence.dispose();
  }
  return c.json({
    id: `chatcmpl-${Math.random().toString(36).substr(2, 9)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: config.modelId,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: cleanResponse(responseText) },
        finish_reason: 'stop',
      },
    ],
  });
});

export default {
  port: config.port,
  fetch: app.fetch,
};
