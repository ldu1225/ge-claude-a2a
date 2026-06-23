# 엔드투엔드 배포 가이드 (End-to-End Setup Guide)

본 가이드는 구글 클라우드 플랫폼(GCP) 프로젝트에 **Gemini Enterprise × Claude Code A2A 연동 아키텍처**를 처음부터 끝까지 안전하게 배포하는 과정을 안내합니다.

---

## 📌 사전 준비 사항 & 원클릭 설치 가이드

본 패키지를 배포하기 위해 컴퓨터에 배포 도구들이 설치되어 있어야 합니다. **컴퓨터에 아무것도 없는 백지상태(Mac OS 권장)** 기준, 터미널을 열고 아래 순서대로 명령어를 복사해서 실행하면 모든 준비가 끝납니다.

### 1. 🛠️ 필수 개발 도구 설치하기 (Mac OS 기준)
터미널을 열고 아래 명령어들을 순서대로 붙여넣으세요:
* **패키지 매니저(Homebrew) 설치 (설치되어 있지 않은 경우에만 실행):**
  ```bash
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  ```
* **gcloud CLI (구글 클라우드 제어 도구) 설치:**
  ```bash
  brew install --cask google-cloud-sdk
  ```
* **Terraform (테라폼) 설치:**
  ```bash
  brew tap hashicorp/tap
  brew install hashicorp/tap/terraform
  ```
* **Node.js 및 jq 설치:**
  ```bash
  brew install node jq
  ```
*(Windows 사용자의 경우 [구글 SDK 공식 다운로드](https://cloud.google.com/sdk/docs/install) 및 [테라폼 공식 다운로드](https://developer.hashicorp.com/terraform/install) 페이지를 통해 일반 프로그램처럼 다운받아 설치하시면 됩니다.)*

### 🔒 2. 구글 클라우드 로그인 및 권한 연동 (필수!)
도구 설치가 끝났다면, 내 컴퓨터가 구글 클라우드 프로젝트를 제어할 수 있도록 **자격 증명(로그인)**을 해야 합니다. 터미널에 아래 두 명령어를 차례대로 실행하세요:

1. **gcloud CLI 사용자 로그인 (웹 브라우저가 열리면 본인의 구글 계정으로 로그인):**
   ```bash
   gcloud auth login
   ```
2. **테라폼 전용 구글 인증(ADC) 로그인 (중요! 테라폼이 구글 API를 찌르기 위해 필수적임):**
   ```bash
   gcloud auth application-default login
   ```
   *(브라우저에서 로그인 승인 버튼을 누르면 자격 증명서가 로컬에 안전하게 저장됩니다.)*

### 💳 3. 결제(Billing)가 활성화된 GCP 프로젝트 준비
* 구글 클라우드는 가상 머신을 켜기 위해 결제 계정이 연결되어 있어야 합니다.
* **[GCP 콘솔 결제 화면]**으로 이동하여 본인의 프로젝트에 신용카드 등 결제 수단이 정상적으로 등록 및 연결되어 있는지 확인해 주십시오.

---

배포를 시작하기 전에 터미널에 본인의 GCP 프로젝트 ID를 환경 변수로 설정합니다:
```bash
export PROJECT_ID="YOUR_PROJECT_ID_HERE" # 예: "my-gcp-project-123"
gcloud config set project $PROJECT_ID
```

---

## ⚠️ 대기업 및 보안망 배포 전 필수 체크리스트 & 충돌 방지 가이드


대기업(LG 계열사 포함) 및 금융권의 엄격한 폐쇄망/보안 GCP 환경에 배포하는 경우, 인프라 충돌을 방지하기 위해 **배포 전에 다음 5가지 사항을 반드시 확인하고 조치**해야 합니다.

### 1. 🌐 내 프로젝트의 VPC 네트워크 이름 알아내기
* **상황:** 대기업 보안 프로젝트는 기본 `default` VPC 네트워크를 강제 삭제하는 경우가 많아, 테라폼이 404 에러로 뻗을 수 있습니다. 따라서 **내가 사용할 실제 VPC 네트워크 이름을 먼저 알아내야 합니다.**
* **알아내는 방법 (택 1):**
  * **방법 A (콘솔 화면):** 구글 클라우드 콘솔 접속 ➔ **[VPC 네트워크]** ➔ **[VPC 네트워크]** 메뉴로 이동하여 목록에 있는 **네트워크 이름**을 복사합니다.
  * **방법 B (터미널 명령어):** 아래 명령어를 복사하여 터미널에 실행하면 즉시 이름 목록이 출력됩니다:
    ```bash
    gcloud compute networks list --project=$PROJECT_ID
    ```
    *(출력된 목록의 `NAME` 열에 적힌 이름을 메모해 둡니다. 예: `default` 또는 `my-custom-vpc` 등)*

### 🔌 2. 설정 파일(`terraform.tfvars`) 생성 및 값 세팅하기
* **상황:** 알아낸 VPC 이름과 주소 대역을 테라폼에 안전하게 전달해야 합니다. 복잡한 명령어를 칠 필요 없이, **`terraform` 폴더 안에 설정 파일(`terraform.tfvars`)을 만들어 두면 테라폼이 자동으로 읽어갑니다.**
* **초초보자용 생성 방법 (터미널 복사-붙여넣기):**
  1. 먼저 터미널에서 **`terraform` 폴더로 이동**합니다:
     ```bash
     cd terraform
     ```
  2. 아래 박스 안의 명령어 **전체를 복사해서 터미널에 그대로 붙여넣기(Paste)하고 Enter**를 누릅니다. (단, `YOUR_PROJECT_ID`와 `YOUR_VPC_NAME` 부분은 본인의 실제 값으로 수정하여 붙여넣으세요!)
     ```bash
     cat << 'EOF' > terraform.tfvars
     project_id      = "YOUR_PROJECT_ID"    # 예: "my-gcp-project-123" (본인의 구글 프로젝트 ID)
     network         = "YOUR_VPC_NAME"      # 예: "default" (위 1단계에서 확인한 VPC 네트워크 이름)
     subnetwork_cidr = "10.20.0.0/24"       # 기본 사설 대역. 만약 사내망(ERP, DB 등)과 충돌 시 "192.168.50.0/24" 등으로 변경
     EOF
     ```
  3. 파일이 에러 없이 예쁘게 잘 만들어졌는지 아래 명령어로 확인해 봅니다:
     ```bash
     cat terraform.tfvars
     ```
     *(방금 입력한 세 줄이 터미널에 그대로 출력되면 성공입니다!)*


### 🧠 3. Vertex AI 내 Anthropic 모델 이용 동의 (Model Garden Agreement)
* **상황:** 에이전트(Claude Code)가 정상적으로 Vertex AI API를 호출하기 위해서는 해당 GCP 프로젝트가 Vertex AI 내의 **Claude 모델 이용 약관에 미리 동의**되어 있어야 합니다. 동의가 누락되면 에이전트 가동 시 `403 Permission Denied` 또는 모델 없음 에러가 발생합니다.
* **조치:** GCP 콘솔 > **Vertex AI** > **Model Garden**으로 이동하여 **Claude 3.5 Sonnet / Claude 3 Opus** 모델을 찾아 **[이용 동의(Enable/Agree)]**를 선제적으로 클릭해 주십시오.

### ⏱️ 4. Compute Engine e2-standard-4 쿼터(Quota) 확보
* **상황:** 워크스테이션 인스턴스는 고성능 연산을 위해 `e2-standard-4` (4 vCPU) 장비를 기본 사용합니다. 신규 GCP 프로젝트나 계정의 경우, 리전별 CPU 사용량 제한 쿼터가 `0`으로 묶여 있어 가상 머신 생성 시 `Quota Exceeded` 에러가 날 수 있습니다.
* **조치:** 가상 머신을 생성할 리전(예: 서울 `asia-northeast3`)에 최소 4 vCPU 이상의 **e2-standard-4 쿼터가 확보되어 있는지 GCP IAM 및 관리자 콘솔에서 확인**하고, 부족할 경우 쿼터 상향을 신청해 주십시오.

### 🔐 5. 배포 계정의 관리자 권한 확보
* **상황:** 인프라를 배포하는 사람의 계정은 최소한 다음 리소스들을 생성/수정할 수 있는 권한이 있어야 합니다. 권한이 부족하면 테라폼 실행 중간에 권한 거부 에러가 납니다.
* **필수 권한:** `roles/workstations.admin` (워크스테이션 클러스터 관리), `roles/run.admin` (라우터 배포), `roles/iam.serviceAccountAdmin` (서비스 계정 생성), `roles/compute.networkAdmin` (서브넷 및 라우터 NAT 생성).

### 🚫 6. 도메인 제한 공유(Domain Restricted Sharing) 조직 정책 예외 처리
* **상황:** 테라폼 배포의 최후반부에서 Cloud Run 서비스(`a2a-router`)에 퍼블릭 인보커 권한을 설정할 때, `One or more users named in the policy do not belong to a permitted customer` 에러와 함께 배포가 거부되는 현상입니다.
* **원인:** 구글 랜딩존 등 보안이 철저한 GCP 환경에서는 프로젝트 외부 도메인이나 퍼블릭(`allUsers`) 권한 부여를 원천 금지하는 조직 정책(**`constraints/iam.allowedPolicyMemberDomains`**)이 강제 적용되어 있기 때문입니다.
* **해결 방법 (GCP 콘솔 조치):**
  1. 구글 클라우드 콘솔에 접속하여 **[조직 정책 (Organization Policies)]** 메뉴로 이동합니다.
  2. 필터 창에 **`constraints/iam.allowedPolicyMemberDomains`** (도메인 제한 공유) 정책을 검색하여 선택합니다.
  3. 상단 프로젝트 선택기에서 **본 에이전트 배포 프로젝트**를 선택합니다.
  4. **[정책 관리 (Manage Policy)]** 버튼을 누릅니다.
  5. **[맞춤설정 (Customize)]**을 선택하고, **[상속된 정책 재정의 (Override parent policy)]**를 활성화합니다.
  6. 규칙(Rules) 추가 버튼을 누르고 정책 값을 **[모두 허용 (Allow All)]**으로 설정하여 저장합니다.
  7. 약 1분 후 테라폼 배포를 재실행하면 조직 정책 검문을 통과하여 100% 완벽하게 가동됩니다.

---

### 🎉 다음 여정 안내: 사전 설정 및 체크리스트를 완료했다면

여기까지 모든 사전 체크와 `terraform.tfvars` 설정 파일 작성을 완료하셨나요? 축하드립니다! 가장 까다로운 대기업 보안망 통과 준비가 완벽히 끝났습니다.

이제 본격적으로 **구글 클라우드에 실제 인프라를 배포하고 연동하는 단계**로 진입합니다.
아래의 **[1단계: 필수 GCP API 활성화]**부터 차례대로 터미널에 명령어를 복사하여 순차적으로 실행해 주시면 됩니다! 🚀

---

## 1단계: 필수 GCP API 활성화

인프라 구축 및 AI 모델 호출에 필요한 핵심 구글 API들을 활성화합니다.
```bash
gcloud services enable \
  workstations.googleapis.com \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  aiplatform.googleapis.com \
  cloudbuild.googleapis.com
```

---

## 2단계: 클라우드 인프라 배포 (Terraform)
테라폼 코드를 통해 서비스 계정, 이미지 레지스트리, 워크스테이션 클러스터 및 Cloud Run 라우터를 자동으로 생성합니다.

### 1. 테라폼 원격 상태 저장용 GCS 버킷 생성 (최초 1회)
테라폼의 상태 파일(`terraform.tfstate`)을 안전하게 보존하기 위해 구글 스토리지 버킷을 생성합니다. (버킷명은 고유해야 합니다)
```bash
export TF_STATE_BUCKET="${PROJECT_ID}-terraform-state"
gcloud storage buckets create "gs://${TF_STATE_BUCKET}" \
  --project "$PROJECT_ID" --location asia-northeast3 --uniform-bucket-level-access
```

### 2. 테라폼 초기화 및 배포 실행

> ⚠️ **배포 전 필수 자격증명 점검:** 
> 테라폼이 내 컴퓨터(로컬)에서 구글 클라우드와 통신하고, 생성한 GCS 금고(백엔드)에 일기장을 안전하게 쓰기 위해서는 **테라폼 전용 구글 인증(ADC)**이 반드시 활성화되어 있어야 합니다.
> 혹시 사전 준비 단계에서 로그인을 건너뛰셨거나 권한 에러가 발생한다면, **지금 터미널에 아래 명령어를 실행하여 웹 브라우저 로그인을 먼저 완료**해 주십시오:
> ```bash
> gcloud auth application-default login
> ```

```bash
cd terraform

# 생성한 GCS 버킷을 백엔드로 주입하여 테라폼 초기화
terraform init -backend-config="bucket=${TF_STATE_BUCKET}"


# 인프라 리소스 배포 적용
# (사전 체크리스트 단계에서 이미 terraform.tfvars 파일을 생성했으므로, 
#  추가 변수 입력 없이 아래 한 줄만 치면 자동으로 모든 값이 읽혀 배포됩니다!)
terraform apply
```

* **결과값 확인 및 메모 (아주 중요!):** 
  배포가 성공하면 터미널 화면 제일 아랫부분에 두 핵심 주소가 자동으로 출력됩니다. 다음 단계들에서 바로 사용되므로 메모장 등에 꼭 복사해 두십시오:
  1. `cloud_run_url`: **6단계(Gemini Enterprise에 커스텀 에이전트 등록)** 및 **5단계(배포 상태 정상 검증)**에서 내 에이전트의 공식 호출 주소로 사용됩니다.
  2. `artifact_registry_repo`: **3단계(워크스테이션 커스텀 컨테이너 이미지 빌드)** 완료 후, 구글 클라우드 콘솔 화면에서 내 이미지가 정상적으로 저장소에 업로드되었는지 대조하고 확인할 때 사용됩니다.



---

## 3단계: 워크스테이션 커스텀 컨테이너 이미지 빌드 (Cloud Build)
에이전트 구동을 위해 Node.js, Claude Code, Gemini CLI, A2A 로컬 데몬이 내장된 프라이빗 도커 이미지를 빌드합니다. 빌드는 구글 클라우드의 **Cloud Build**를 사용하여 원격 실행되므로, 로컬 PC에 도커 엔진이 없어도 안전하게 빌드할 수 있습니다.

```bash
cd ../workstation-image

# Cloud Build를 이용한 이미지 컴파일 및 Artifact Registry 푸시 자동 실행
PROJECT_ID=$PROJECT_ID ./build.sh
```

### 💡 이미지 테라폼 재반영
빌드가 완료되면 터미널에 생성된 이미지 주소(URI)가 출력됩니다. 이 이미지를 테라폼에 주입하여 워크스테이션 설정을 최종 업데이트합니다.
```bash
cd ../terraform
WS_IMAGE="asia-northeast3-docker.pkg.dev/${PROJECT_ID}/a2a-agent-images/a2a-workstation:latest"

terraform apply \
  -var="project_id=${PROJECT_ID}" \
  -var="workstation_image=${WS_IMAGE}"
```

---

## 4단계: A2A 라우터 배포 (Cloud Run)
제미나이 대화창에서 들어오는 인증 토큰을 검증하고 사용자 가상 머신으로 신호를 연결해 주는 프록시 라우터를 빌드 및 배포합니다.
```bash
cd ../a2a-router

# 라우터 소스 빌드, 배포 및 퍼블릭 URL 패치 자동 실행
PROJECT_ID=$PROJECT_ID ./deploy.sh
```

---

## 5단계: 배포 상태 정상 검증
라우터가 제미나이 엔터프라이즈에 등록할 에이전트 스펙 카드(`agent-card.json`)를 정상적으로 반환하는지 검증합니다.
```bash
ROUTER_URL=$(gcloud run services describe a2a-router \
  --project $PROJECT_ID \
  --region us-central1 \
  --format "value(status.url)")

curl "${ROUTER_URL}/.well-known/agent-card.json" | jq .
```
정상 작동 시 에이전트의 이름, 설명, 연동 스코프 정보가 JSON 형태로 출력됩니다.

---

## 6단계: Gemini Enterprise에 커스텀 에이전트 등록 및 최종 검증

구글 클라우드 공식 가이드라인([GCP 공식 문서](https://docs.cloud.google.com/gemini/enterprise/docs/register-and-manage-an-a2a-agent))에 따라, 구글 클라우드 콘솔의 Gemini Enterprise 제어창에서 에이전트를 등록하고 OAuth 보안 연동을 완료합니다.

### 1. 🔒 GCP OAuth 클라이언트 ID 발급 (사전 준비)
제미나이 플랫폼이 사용자를 대신해 구글 클라우드 자원에 접근하고 보안 인증(OAuth 2.0)을 수행할 수 있도록 자격 증명을 발급받습니다.

1. **GCP 콘솔** > **API 및 서비스** > **[사용자 인증 정보]** 메뉴로 이동합니다.
2. 상단의 **[+ 사용자 인증 정보 만들기]** ➔ **[OAuth 클라이언트 ID]**를 선택합니다.
3. 애플리케이션 유형을 **[웹 애플리케이션 (Web Application)]**으로 선택합니다.
4. 이름(예: `Gemini-A2A-Router-Client`)을 입력합니다.
5. **[승인된 리디렉션 URI (Authorized Redirect URIs)]** 섹션으로 이동하여 **[+ URI 추가]**를 누르고, 구글 공식 A2A 연동 리디렉션 주소 2개를 정확히 입력합니다:
   * `https://vertexaisearch.cloud.google.com/oauth-redirect`
   * `https://vertexaisearch.cloud.google.com/static/oauth/oauth.html`
6. **[만들기]**를 누르고, 생성 팝업창에서 **[JSON 다운로드]** 버튼을 눌러 자격 증명 파일(`client_secret_xxxx.json`)을 컴퓨터에 다운로드합니다.
   *(이 파일 안에 `Client ID`, `Client secret`, `Authorization URI`, `Token URI`가 모두 들어있습니다.)*

### 2. 📄 에이전트 스펙 JSON 카드 확인 및 복사
1. 웹 브라우저를 열고 **5단계에서 확인한 에이전트 카드 URL**로 접속합니다:
   `https://[YOUR_CLOUD_RUN_ROUTER_URL]/.well-known/agent-card.json`
2. **출력값 확인 (1차 검증):** 화면에 에이전트의 스펙 정보(프로토콜 버전 `0.3`, 이름, 주소, skills 등)가 담긴 **JSON 텍스트 블록**이 깨끗하게 출력되는지 확인합니다.
3. 화면에 출력된 **JSON 데이터 전체를 드래그하여 복사(Copy)** 합니다.

### 3. 🖥️ 구글 클라우드 콘솔에서 에이전트 등록
1. **GCP 콘솔** > **[Gemini Enterprise]** (`console.cloud.google.com/gemini-enterprise/`) 페이지로 이동합니다.
2. 에이전트를 등록할 **Gemini Enterprise 앱(App)**의 이름을 클릭합니다.
3. 왼쪽 메뉴에서 **[에이전트 (Agents)]** ➔ **[+ 에이전트 추가 (Add Agents)]**를 클릭합니다.
4. 에이전트 유형 선택 화면에서 **[A2A를 통한 커스텀 에이전트 (Custom agent via A2A)]**의 **[추가 (Add)]** 버튼을 누릅니다.
5. **[에이전트 카드 JSON (Agent card JSON)]** 입력창에 위 **2단계에서 복사해 둔 JSON 텍스트 전체**를 그대로 붙여넣습니다.
6. **[에이전트 세부정보 미리보기 (Preview agent details)]** ➔ **[다음 (Next)]**을 누릅니다.
7. **OAuth 보안 인증 정보 입력 (GCP ↔ Gemini 연동):**
   * **Client ID & Client secret:** 위 1단계에서 다운로드한 JSON 파일에 적힌 값을 복사해 입력합니다.
   * **Authorization URI & Token URI:** 다운로드한 JSON 파일 내부의 URI 주소값을 각각 대조하여 입력합니다.
   * **Scopes:** 에이전트 매핑과 권한 검증에 필요한 기본 범위(예: `email`, `openid` 등)를 입력합니다.
8. **[완료 (Finish)]** 버튼을 누르면 정식 등록이 완료됩니다.

### 4. 🎯 제미나이 UI에서 최종 작동성 검증
1. 정식 구글 워크스페이스 사용자 계정으로 **Gemini Enterprise 채팅 화면** (`gemini.google.com`)에 접속합니다.
2. 채팅창 메뉴의 **확장 기능(Extensions)** 목록 또는 에이전트 갤러리에 방금 등록한 에이전트(예: `Hello World Agent`)가 정상적으로 노출되고 활성화되어 있는지 확인합니다.
3. 대화창에 `@에이전트_이름`을 호출하거나 관련 질문을 던져, 에이전트가 가상 머신(Workstation)과 통신하여 성공적으로 리치 A2UI 카드를 렌더링하고 작업을 수행하는지 최종 확인합니다!



---

## 🛠️ 장애 진단 및 모니터링 (Troubleshooting)

* **워크스테이션 부팅이 되지 않는 경우:** 선택하신 리전(Region) 내에 `e2-standard-4` 장비의 리소스 쿼터(Quota) 제한이 걸려있지 않은지 GCP 콘솔에서 확인해 주세요.
* **Claude가 Vertex AI 권한 오류를 뱉는 경우:** 사용하시는 GCP 프로젝트가 Vertex AI Model Garden 내의 **Anthropic Claude 모델** 사용 인가(Agreement)를 완료했는지 확인해 주세요.
* **로그 확인 방법:**
  * **라우터 게이트웨이 로그:** `gcloud run services logs read a2a-router`
  * **가상 머신 내부 로그:** Cloud Workstations 웹 콘솔 내 **"로그(Logs)"** 탭 클릭 또는 터미널 접속 후 `/var/log/a2a-server.log` 확인.
