# 엔드투엔드 배포 가이드 (End-to-End Setup Guide)

본 가이드는 구글 클라우드 플랫폼(GCP) 프로젝트에 **Gemini Enterprise × Claude Code A2A 연동 아키텍처**를 처음부터 끝까지 안전하게 배포하는 과정을 안내합니다.

---

## 📌 사전 준비 사항

* 결제가 활성화된 **GCP 프로젝트**
* 프로젝트 소유자(Owner) 또는 편집자(Editor) 권한이 인가된 **`gcloud` CLI** 환경
* **Terraform** >= 1.5
* **Node.js** >= 20 (라우터를 로컬에서 개발/디버깅하려는 경우에만 필요)

배포를 시작하기 전에 터미널에 본인의 GCP 프로젝트 ID를 환경 변수로 설정합니다:
```bash
export PROJECT_ID="YOUR_PROJECT_ID_HERE"
gcloud config set project $PROJECT_ID
```

---

## ⚠️ 대기업 및 보안망 배포 전 필수 체크리스트 & 충돌 방지 가이드

대기업(LG 계열사 포함) 및 금융권의 엄격한 폐쇄망/보안 GCP 환경에 배포하는 경우, 인프라 충돌을 방지하기 위해 **배포 전에 다음 5가지 사항을 반드시 확인하고 조치**해야 합니다.

### 1. 🌐 default VPC 네트워크 존재 여부 확인 (가장 빈번한 에러!)
* **상황:** 대기업 보안 프로젝트는 생성과 동시에 기본 `default` VPC 네트워크를 강제 삭제하는 경우가 많습니다. 이 상태에서 기본값으로 배포하면 서브넷 생성 시 `404 Not Found` 에러가 발생합니다.
* **조치:** 고객사 네트워크 팀에 **사용 중인 실제 사설 VPC 이름**을 확인하고, `terraform.tfvars` 파일에 아래와 같이 기재하여 오버라이드하십시오:
  ```hcl
  network = "고객사의_사설_VPC_네트워크_이름"
  ```

### 2. 🔌 사설 IP 대역 (CIDR) 중복 여부 확인
* **상황:** 본 아키텍처는 가상 머신 격리를 위해 기본적으로 `10.20.0.0/24` 사설 IP 대역을 신규 개척하여 사용합니다. 만약 이 대역을 기존 사내망(ERP, DB 등)이 이미 점유하고 있다면 **IP 충돌 에러**가 발생합니다.
* **조치:** 네트워크 팀에 **"현재 사용하지 않는 빈 사설 IP 대역(/24 범위)"**을 할당받아 `terraform.tfvars` 파일에 주입하십시오:
  ```hcl
  subnetwork_cidr = "192.168.50.0/24" # 할당받은 빈 대역 기입
  ```

### 🧠 3. Vertex AI 내 Anthropic 모델 이용 동의 (Model Garden Agreement)
* **상황:** 에이전트(Claude Code)가 정상적으로 Vertex AI API를 호출하기 위해서는 해당 GCP 프로젝트가 Vertex AI 내의 **Claude 모델 이용 약관에 미리 동의**되어 있어야 합니다. 동의가 누락되면 에이전트 가동 시 `403 Permission Denied` 또는 모델 없음 에러가 발생합니다.
* **조치:** GCP 콘솔 > **Vertex AI** > **Model Garden**으로 이동하여 **Claude 3.5 Sonnet / Claude 3 Opus** 모델을 찾아 **[이용 동의(Enable/Agree)]**를 선제적으로 클릭해 주십시오.

### ⏱️ 4. Compute Engine e2-standard-4 쿼터(Quota) 확보
* **상황:** 워크스테이션 인스턴스는 고성능 연산을 위해 `e2-standard-4` (4 vCPU) 장비를 기본 사용합니다. 신규 GCP 프로젝트나 계정의 경우, 리전별 CPU 사용량 제한 쿼터가 `0`으로 묶여 있어 가상 머신 생성 시 `Quota Exceeded` 에러가 날 수 있습니다.
* **조치:** 가상 머신을 생성할 리전(예: 서울 `asia-northeast3`)에 최소 4 vCPU 이상의 **e2-standard-4 쿼터가 확보되어 있는지 GCP IAM 및 관리자 콘솔에서 확인**하고, 부족할 경우 쿼터 상향을 신청해 주십시오.

### 🔐 5. 배포 계정의 관리자 권한 확보
* **상황:** 인프라를 배포하는 사람의 계정은 최소한 다음 리소스들을 생성/수정할 수 있는 권한이 있어야 합니다. 권한이 부족하면 테라폼 실행 중간에 권한 거부 에러가 납니다.
* **필수 권한:** `roles/workstations.admin` (워크스테이션 클러스터 관리), `roles/run.admin` (라우터 배포), `roles/iam.serviceAccountAdmin` (서비스 계정 생성), `roles/compute.networkAdmin` (서브넷 및 라우터 NAT 생성).

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
```bash
cd terraform

# 생성한 GCS 버킷을 백엔드로 주입하여 테라폼 초기화
terraform init -backend-config="bucket=${TF_STATE_BUCKET}"

# 인프라 리소스 배포 적용
terraform apply -var="project_id=${PROJECT_ID}"
```

* **참고 (VPC 커스터마이징 및 default VPC 삭제 대응):** 
  본 아키텍처는 기본적으로 프로젝트의 `default` VPC 네트워크를 사용합니다. 
  > ⚠️ **중요 (보안 강화 환경):** 대기업이나 금융권 등 보안이 철저한 GCP 프로젝트에서는 기본 `default` 네트워크가 삭제되어 있는 경우가 많습니다. 이 경우 변수를 재정의하지 않으면 서브넷 생성 시 `404 Not Found` 에러가 발생합니다. 본인들이 사용하는 **실제 사설 VPC 네트워크명**을 아래와 같이 반드시 변수로 재정의하여 배포하십시오:
  ```bash
  terraform apply \
    -var="project_id=${PROJECT_ID}" \
    -var="network=사용자_VPC_네트워크_이름" \
    -var="subnetwork=a2a-ws-subnet"
  ```
  *(프로덕션 환경에서는 명령어마다 변수를 치는 대신 `terraform.tfvars` 파일을 생성하여 `project_id` 및 `network` 변수를 영구적으로 기재하여 사용하는 것을 권장합니다.)*

* **참고 (기존 Cloud NAT 및 Router 재사용):** 
  만약 고객사 VPC 네트워크에 이미 인터넷 아웃바운드용 Cloud NAT와 Router가 구성되어 있다면, 불필요한 이중 지출 및 보안 통로 분산을 막기 위해 아래와 같이 `create_nat=false` 변수를 주입하여 배포합니다. 이 경우 테라폼은 라우터와 NAT 생성을 안전하게 건너뛰고 기존 인프라를 재사용합니다:
  ```bash
  terraform apply \
    -var="project_id=${PROJECT_ID}" \
    -var="create_nat=false"
  ```

* **결과값 확인:** 배포가 완료되면 화면에 출력되는 `artifact_registry_repo` 및 `cloud_run_url` 주소를 메모해 둡니다.


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

## 6단계: Gemini Enterprise에 커스텀 에이전트 등록

1. **Google Workspace 관리자 콘솔** (`admin.google.com`)에 로그인합니다.
2. **앱 (Apps)** > **Gemini Enterprise** > **에이전트 플랫폼 (Agent Platform)** 메뉴로 이동합니다.
3. **[에이전트 추가]** 버튼을 누르고, 앞서 5단계에서 확인한 **에이전트 카드 URL**을 입력합니다:
   `https://[YOUR_CLOUD_RUN_ROUTER_URL]/.well-known/agent-card.json`
4. 제미나이가 자동으로 에이전트의 프로필, 아이콘 및 권한 범위를 해독하여 등록을 완료합니다.
5. **OAuth 설정 확인:** 제미나이가 사용하는 OAuth 클라이언트가 유저의 `email` 범위(Scope)를 조회할 수 있도록 인가되었는지 확인하십시오. 라우터가 들어오는 요청을 사람별 가상 머신으로 매핑할 때 이메일 식별자가 반드시 필요합니다.

---

## 🛠️ 장애 진단 및 모니터링 (Troubleshooting)

* **워크스테이션 부팅이 되지 않는 경우:** 선택하신 리전(Region) 내에 `e2-standard-4` 장비의 리소스 쿼터(Quota) 제한이 걸려있지 않은지 GCP 콘솔에서 확인해 주세요.
* **Claude가 Vertex AI 권한 오류를 뱉는 경우:** 사용하시는 GCP 프로젝트가 Vertex AI Model Garden 내의 **Anthropic Claude 모델** 사용 인가(Agreement)를 완료했는지 확인해 주세요.
* **로그 확인 방법:**
  * **라우터 게이트웨이 로그:** `gcloud run services logs read a2a-router`
  * **가상 머신 내부 로그:** Cloud Workstations 웹 콘솔 내 **"로그(Logs)"** 탭 클릭 또는 터미널 접속 후 `/var/log/a2a-server.log` 확인.
