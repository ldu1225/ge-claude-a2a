# A2A 라우터 (Cloud Run Gateway & Workstation Executor)

본 디렉토리는 **Gemini Enterprise 대화창**과 **사용자별 독립된 Cloud Workstation 가상 머신** 사이를 유기적으로 연결하고 백그라운드 코딩 프로세스를 조율하는 **A2A(Agent-to-Agent) 라우팅 엔진**입니다.

이 라우터는 단일 코드베이스로 작성되었으나, 설정된 환경 변수(`AGENT_FORWARD_MODE`)에 따라 **두 가지 상이한 실행 프로필(Gateway Mode vs. Executor Mode)**로 각각 영리하게 동적 전환되어 구동됩니다.

---

## 🏗️ 1. 두 가지 실행 모드 (Dual Execution Profiles)

### 🚀 프로필 A: 게이트웨이 모드 (Stateless Gateway Mode)
* **실행 환경:** Cloud Run (퍼블릭 인터넷 웹 호스팅)
* **환경 변수:** `AGENT_FORWARD_MODE=workstation` (기본값)
* **핵심 임무:**
  1. **에이전트 카드 공시:** Gemini Enterprise의 검색 등록용 스펙 주소인 `/.well-known/agent-card.json` 규격을 호스팅합니다.
  2. **사용자 신원 식별 (OAuth):** 들어오는 요청의 `Authorization: Bearer` 토큰을 해석하거나 IAP 헤더를 해석하여 사용자의 이메일 주소(예: `admin@dulee.altostrat.com`)를 안전하게 추출합니다.
  3. **워크스테이션 수명 주기 관리:** 해당 사용자의 전용 가상 머신(Cloud Workstation)이 존재하는지 조회하고, 만약 꺼져 있다면 **Google Cloud Workstations API를 즉시 호출하여 자동으로 부팅(Provisioning/Start)**시킵니다.
  4. **보안 인가 포워딩:** GCP 가상 머신의 웹 주소는 외부 일반인에게 잠겨 있습니다. 게이트웨이는 Google API를 통해 획득한 서비스 계정의 임시 서비스 웹 토큰(`generateAccessToken()`)을 요청에 바인딩하여, 사용자의 개인 가상 머신 내 내부 서버(포트 8080)로 요청을 보안 터널을 통해 안전하게 포워딩합니다.

### 💻 프로필 B: 실행기 모드 (Local Agent Executor Mode)
* **실행 환경:** 사용자 개인별 Cloud Workstation 컨테이너 내부
* **환경 변수:** `AGENT_FORWARD_MODE=local`
* **핵심 임무:**
  1. **SDK 서브프로세스 파이프라인:** 게이트웨이로부터 포워딩된 JSON-RPC 및 SSE 요청을 해석하여, 컨테이너 내부에 설치된 **Claude Agent SDK 서브프로세스를 즉시 기동**합니다.
  2. **양방향 I/O 스트리밍:** 에이전트의 실시간 생각 및 답변 스트림(stdout)과 파일 조작/명령 실행에 대한 승인 피드백(stdin)을 양방향 스트리밍 파이프로 실시간 제어합니다.
  3. **세션 영구 보존 및 복구:** 대화 고유 ID(`contextId`)를 키값으로 삼아 가상 머신의 영구 디스크 공간(`~/.a2a-sessions/`)에 Claude 세션 토큰을 암호화하여 기록합니다. 이를 통해 사용자가 폰에서 대화하다가 터미널로 넘어와서 `a2a-resume`을 치면 디스크의 세션 키를 자동 판독하여 **정확히 하던 대화 문맥의 마지막 시점부터 즉시 복구(Resume)**시킵니다.

---

## 🛡️ 2. 실시간 JSON 자가 복구 엔진 (Self-Healing Parser)

라우터 코어(`src/executor.ts` 내 `repairJson` 유틸리티)에는 LLM의 문법 오류로 인한 대시보드 렌더링 폭사를 원천적으로 치료하는 **실시간 자가 복구 알고리즘**이 구현되어 있습니다:

```typescript
function repairJson(str: string): string {
  let cleaned = str.trim();

  // 🛠️ 치료 1: 문자열 값 내부의 이스케이프 되지 않은 생 개행문자(\n) 처리
  // LLM이 설명 글이나 빌드 로그 등 멀티라인 텍스트를 JSON 값에 넣을 때 발생하는 구문 에러 교정
  cleaned = cleaned.replace(/"([^"\\]*(?:\\.[^"\\]*)*)"/gs, (match, p1) => {
    return '"' + p1.replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '"';
  });

  // 🛠️ 치료 2: 객체나 배열의 가장 마지막 원소 뒤에 남겨진 불필요한 콤마(Trailing Comma) 제거
  cleaned = cleaned.replace(/,(\s*[\]}])/g, "$1");

  // 🛠️ 치료 3: 잘림(Truncation) 또는 닫기 누락으로 인한 불균형 괄호 복구
  // 열린 중괄호/대괄호 개수 스택을 실시간 연산하여 부족한 닫기 문자(}, ])를 문자열 끝에 역순으로 자동 충전!
  const stack: ("{" | "[")[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (c === "{") stack.push("{");
    else if (c === "[") stack.push("[");
    else if (c === "}") {
      if (stack[stack.length - 1] === "{") stack.pop();
    } else if (c === "]") {
      if (stack[stack.length - 1] === "[") stack.pop();
    }
  }
  while (stack.length > 0) {
    const open = stack.pop();
    if (open === "{") cleaned += "}";
    else if (open === "[") cleaned += "]";
  }

  return cleaned;
}
```

---

## 👤 3. 사용자 식별 헤더 해상도 (Identity Resolution)

게이트웨이 모드 구동 시, 다중 테넌시(Multi-tenancy) 환경을 안전하게 보장하기 위해 다음의 순서로 인입되는 보안 헤더를 순차 추적하여 사용자의 고유 이메일을 해독합니다:

1. **`Authorization: Bearer <JWT>`**
   * Gemini Enterprise에서 전송되는 사용자 OAuth 토큰입니다. JWT 디코딩 과정을 통해 `email` 필드 또는 `sub` 클레임 값을 조회합니다.
2. **`X-Forwarded-Email`**
   * 상단에 별도의 Identity-Aware Proxy(IAP)가 배치되어 있는 경우 인입되는 헤더입니다.
3. **`X-Goog-Authenticated-User-Email`**
   * 구글 클라우드 공식 IAP 게이트웨이를 거쳐 서명된 유저 이메일 헤더입니다.

---

## 🛠️ 개발 및 배포 환경 변수 명세

라우터 및 실행기 프로세스를 세부 튜닝하기 위한 핵심 환경 변수 구성표입니다:

| 환경 변수명 | 권장 설정값 | 설명 |
| :--- | :--- | :--- |
| `AGENT_FORWARD_MODE` | `workstation` \| `local` | `workstation`은 Cloud Run 프록시용 게이트웨이 모드, `local`은 가상 머신 내부 실행기 모드입니다. |
| `PROJECT_ID` | *(GCP 프로젝트 ID)* | 라우팅할 워크스테이션 인프라가 배포된 GCP 프로젝트의 고유 식별자입니다. |
| `WORKSTATION_REGION` | `asia-northeast3` (기본값) | 사용자별 Cloud Workstation 클러스터가 배포된 물리 GCP 리전입니다. |
| `CLUSTER_ID` | `ai-agents-cluster` | 테라폼으로 배포된 워크스테이션 물리 클러스터 ID입니다. |
| `CONFIG_ID` | `a2a-agent-config` | 가상 머신의 CPU 사양 및 디스크 정책이 정의된 하드웨어 설정 ID입니다. |
| `A2A_DISABLE_A2UI` | `false` | `true`로 설정 시 모든 A2UI 리치 카드 파싱을 비활성화하고 순수 텍스트 마크다운으로 강제 전환합니다. |
| `CLAUDE_HOME` | `/home/user` | 가상 머신 내부에서 Claude SDK가 참조할 홈 디렉토리 경로입니다. |

---

## 🚀 로컬 빌드 및 수동 배포

본 패키지는 TypeScript로 구성되어 있으며 완전 무중단 프로덕션 빌드가 지원됩니다:

```bash
# 1. 의존성 패키지 로컬 설치
npm install

# 2. TypeScript 컴파일러 가동 (dist/ 빌드 폴더 생성)
npm run build

# 3. 로컬 테스트 서버 수동 기동 (8080 포트)
npm start
```
