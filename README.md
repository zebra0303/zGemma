# zGemma

로컬에서 **Gemma 4** GGUF 모델을 구동하는 OpenAI 호환 API 서버입니다.
[Bun](https://bun.com) + [Hono](https://hono.dev) + [node-llama-cpp](https://node-llama-cpp.withcat.ai) 기반이며,
Ollama와 동일한 포트(`11434`)를 사용해 OpenCode / Pi Agent 등 에이전트 도구와 바로 연동됩니다.

## 1. 의존성 설치

```bash
bun install
```

## 2. Gemma 4 모델 다운로드

```bash
# huggingface-cli 사용
bunx huggingface-cli download ggml-org/gemma-4-12B-it-GGUF gemma-4-12B-it-Q4_K_M.gguf --local-dir . --local-dir-use-symlinks False

# 또는 curl 사용
curl -L -o gemma-4-12b-it-Q4_K_M.gguf https://huggingface.co/ggml-org/gemma-4-12B-it-GGUF/resolve/main/gemma-4-12B-it-Q4_K_M.gguf
```

## 3. gemma4 지원 llama.cpp 빌드 (중요)

`node-llama-cpp 3.18.1`에 동봉된 프리빌트 바이너리는 `gemma4` 아키텍처를 모릅니다
(`unknown model architecture: 'gemma4'`). 따라서 gemma4를 지원하는 llama.cpp 릴리스를
직접 빌드해야 합니다.

```bash
bunx --no node-llama-cpp source download --release b8638
```

> **왜 `b8638`인가?**
> - gemma4 지원은 llama.cpp `b8635`/`b8638`(2026-04-02)부터 들어왔습니다.
> - 그보다 최신 릴리스는 `node-llama-cpp 3.18.1`의 애드온/빌드 설정과 충돌합니다
>   (`cpu_get_num_math` 이름 변경, `std::atomic_bool` 복사 금지, `common` 라이브러리 타깃명 변경 등).
> - `b8638`은 gemma4를 지원하면서도 `3.18.1`과 깔끔히 빌드되는 안정 지점입니다.
>
> 빌드 후 `getLlama()`가 자동으로 로컬 빌드(`localBuild`)를 사용합니다.
> `bun install`로 `node_modules`를 다시 설치하면 이 빌드가 사라지므로, 그때는 위 명령을 다시 실행하세요.

## 4. 환경설정 (선택)

설정값은 `.env`로 분리되어 있습니다. Bun이 `.env`를 자동 로드하므로 별도 설정은 필요 없습니다.

```bash
cp .env.example .env   # 필요하면 값 수정
```

| 환경변수 | 설명 | 기본값 |
| --- | --- | --- |
| `MODEL_PATH` | gguf 모델 파일 경로 (상대 경로면 실행 디렉터리 기준) | `gemma-4-12b-it-Q4_K_M.gguf` |
| `MODEL_ID` | OpenAI 호환 응답에 노출할 모델 id | `gemma-4` |
| `CONTEXT_SIZE` | 컨텍스트 크기 (16GB RAM 기준 4096 권장, 최대 8192) | `4096` |
| `THREADS` | 추론 스레드 수 | `4` |
| `PORT` | 서버 포트 | `11434` |

모든 값에 기본값이 있어 `.env` 없이도 동작합니다.

## 5. 실행

```bash
bun run index.ts
```

`✅ 모델 로드 완료! 서버가 준비되었습니다.` 로그가 보이면 준비 완료입니다.

## 6. 테스트

서버가 떠 있는 상태에서 아래 요청으로 확인합니다. (`PORT`를 바꿨다면 포트도 맞춰주세요.)

### 모델 목록

```bash
curl http://localhost:11434/v1/models
```

### 스트리밍 채팅

```bash
curl http://localhost:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "안녕? 너는 누구야?"}], "stream": true}'
```

### 논스트리밍 채팅

```bash
curl http://localhost:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "안녕? 너는 누구야?"}], "temperature": 0}'
```

정상이라면 `<|channel>thought ...` 같은 마커 없이 깔끔한 답변만 반환됩니다.
(서버가 Gemma 4의 interleaved-thinking 채널 스캐폴딩을 자동으로 제거합니다.)

## 엔드포인트

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| `GET` | `/v1/models` | 가상 모델 목록 (OpenAI 호환) |
| `POST` | `/v1/chat/completions` | 채팅 완성 (스트리밍/논스트리밍, `stream`·`temperature` 지원) |

---

This project was created using `bun init` in bun v1.3.14.
