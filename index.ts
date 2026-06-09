import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamText } from 'hono/streaming';
import { getLlama, LlamaChatSession } from 'node-llama-cpp';
import * as path from 'path';

const app = new Hono();
app.use('*', cors()); // 에이전트 도구들의 크로스 오리진 요청 허용

// 1. 런타임 및 모델 로드
const llama = await getLlama();
const modelPath = path.join(process.cwd(), 'gemma-4-12b-it-Q4_K_M.gguf'); // 다운로드한 모델 파일명

console.log('⏳ Gemma 4 모델 로드 중...');
const model = await llama.loadModel({ modelPath });

// 컨텍스트는 요청마다가 아니라 시작 시 한 번만 생성한다.
// 16GB RAM에서 안전한 컨텍스트 크기는 4096(4K). 더 긴 입력이 필요하면 최대 8192(8K)까지 타협.
const context = await model.createContext({
  contextSize: 4096,
  threads: 4, // M1 성능 코어 수에 맞춰 빠른 첫 토큰(TTFT) 확보
});
console.log('✅ 모델 로드 완료! 서버가 준비되었습니다.');

// 2. OpenAI 호환 가상 모델 목록 엔드포인트
app.get('/v1/models', (c) => {
  return c.json({
    object: 'list',
    data: [{ id: 'gemma-4', object: 'model', created: Date.now(), owned_by: 'local' }],
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

      try {
        await evaluator.prompt(userMessage, {
          temperature,
          onTextChunk: (text) => {
            // OpenAI Stream 포맷 엄격 준수
            const payload = {
              id: chunkId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: 'gemma-4',
              choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
            };
            serverStream.write(`data: ${JSON.stringify(payload)}\n\n`);
          },
        });

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
    model: 'gemma-4',
    choices: [
      { index: 0, message: { role: 'assistant', content: responseText }, finish_reason: 'stop' },
    ],
  });
});

export default {
  port: 11434, // Ollama와 동일한 포트를 써서 에이전트 호환성 극대화
  fetch: app.fetch,
};
