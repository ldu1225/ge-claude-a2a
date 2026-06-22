# 테라폼 인프라스트럭처 정의 (Terraform IaC)

본 디렉토리는 **Gemini Enterprise A2A 에이전트 아키텍처**를 구글 클라우드 플랫폼(GCP) 위에 안전하고 표준화된 방식으로 완전 자동 구축하기 위한 **Terraform( IaC) 코드 패키지**입니다.

이 IaC 구성은 대기업 가이드라인을 준수하여 **물리적인 망 분리(VPC Subnet)**, **사용자 격리(IAM Least Privilege)** 및 **철저한 비용 통제(Watchdog & Timeout)**가 아키텍처 레벨에서 견고하게 적용되어 있습니다.

---

## 🏗️ 1. 주요 배포 자원 및 보안 아키텍처 (Resources)

### 🔒 A. 서비스 계정 및 최소 권한의 법칙 (IAM)
* **생성 자원:** `a2a-agent@<project-id>.iam.gserviceaccount.com`
* **역할 및 권한 설계:**
  1. `roles/workstations.user`: 사용자의 가상 머신(Cloud Workstation)을 조회하고 시작할 수 있는 제어 권한.
  2. `roles/aiplatform.user`: Anthropic Claude Code 및 Gemini 모델 호출을 위한 Vertex AI 사용 권한 (별도의 API 키 발급이 불필요하여 보안 노출 제로).
  3. `roles/artifactregistry.reader`: 워크스테이션 인스턴스가 프라이빗 Artifact Registry의 커스텀 이미지를 안전하게 다운로드하여 부팅할 수 있는 권한.

### 🌐 B. 전용 서브넷 망 분리 (VPC Networking)
* **생성 자원:** `a2a-ws-subnet` (VPC 이름: `default` 또는 변수로 커스텀 지정 가능)
* **네트워크 명세:**
  * CIDR 대역: `10.20.0.0/24` (기본값, 타 서브넷과 중복되지 않도록 변수로 완벽 격리)
  * 프라이빗 서브넷 환경으로 구동되며, 가상 머신 인스턴스는 외부 공인 IP를 직접 부여받지 않고 안전하게 사설 IP로만 통신합니다.

### 💻 C. 사용자별 클러스터 및 하드웨어 명세 (Cloud Workstations)
* **물리 클러스터:** `ai-agents-cluster` (리전: `asia-northeast3` 서울 리전 기본 권장)
* **하드웨어 구성 설정(Config):** `a2a-agent-config`
  * 인스턴스 스펙: `e2-standard-4` (4 vCPU, 16GB RAM) — 자율 코딩 에이전트와 로컬 개발 서버가 버퍼링 없이 고성능으로 구동될 수 있는 최적의 개발 물리 스펙.
  * 프라이빗 레지스트리 연동: Artifact Registry에 배포된 최신 커스텀 도커 이미지(`workstation-image`)가 이 설정에 자동 바인딩되어 기동됩니다.

### ⏱️ D. 엄격한 비용 제어 정책 (Watchdog Policy)
* **유휴 자동 종료 (Idle Timeout):** `600초 (10분)`
  * 사용자가 웹 IDE(VS Code) 창을 닫거나, 에이전트 채팅을 10분 동안 사용하지 않으면 가상 머신이 **자동으로 일시 정지(Stop) 상태**로 돌입하여 불필요하게 낭비되는 컴퓨팅 비용을 원천 차단합니다.
* **최대 가동 시간 제한 (Running Timeout):** `7200초 (2시간)`
  * 어떠한 활동 여부와 관계없이 가상 머신이 켜진 지 2시간이 경과하면 무조건 일시 정지시켜, 밤샘 구동이나 무한 루프 버그로 인한 대규모 청구서 폭탄을 방지합니다.
* **영구 영토 보존:** 가상 머신이 꺼지더라도 사용자의 영구 디스크(Persistent Disk, `/home/user`)는 온전하게 보존되므로 다시 켜는 즉시 작업 내용과 설정이 100% 복구됩니다.

---

## 🛠️ 2. 입력 변수 명세 (Variables)

배포 대상 환경에 맞춰 자유롭게 조절할 수 있도록 완벽하게 매개변수화(Parameterize) 되어 있습니다:

| 변수명 | 기본값 | 필수 여부 | 설명 |
| :--- | :--- | :---: | :--- |
| `project_id` | *(없음)* | **YES** | 자원을 배포할 GCP 프로젝트 ID입니다. |
| `workstation_region` | `asia-northeast3` | No | Cloud Workstations 클러스터가 위치할 물리적 지리 리전 (서울 권장). |
| `cloud_run_region` | `us-central1` | No | 라우터 게이트웨이가 올라갈 Cloud Run 배포 리전. |
| `vertex_ai_region` | `us-east5` | No | Claude Code 모델 API가 구동될 Vertex AI 서빙 리전. |
| `network` | `default` | No | 워크스테이션 클러스터가 연결될 물리 VPC 네트워크명. |
| `subnetwork` | `a2a-ws-subnet` | No | 신규 생성될 전용 사설 서브넷 이름. |
| `subnetwork_cidr` | `10.20.0.0/24` | No | 신규 생성될 사설 서브넷의 IP 대역 범위. |
| `workstation_machine_type` | `e2-standard-4` | No | 가상 머신의 CPU/Memory 하드웨어 규격. |
| `workstation_idle_timeout_seconds` | `600` | No | 유휴 상태 돌입 시 자동 종료 대기 시간 (초 단위). |

---

## 🚀 3. 상세 단계별 배포 가이드

### 1단계: 테라폼 초기화 및 백엔드 설정
테라폼 상태 관리 파일(`terraform.tfstate`)을 안전하게 공유하기 위해, 배포 전 미리 구글 스토리지 버킷(GCS)을 생성하여 백엔드로 바인딩하는 것을 적극 권장합니다.
```bash
# 1. 테라폼 백엔드용 GCS 버킷이 없는 경우 사전에 생성합니다.
gsutil mb -l asia-northeast3 gs://your-project-id-terraform-state

# 2. 버킷명을 주입하여 테라폼 초기화를 수행합니다.
terraform init -backend-config="bucket=your-project-id-terraform-state"
```

### 2단계: 배포 플랜 검토 (Plan)
클라우드 리소스를 실제로 배포하기 전, 어떤 자원들이 추가되거나 변경되는지 안전하게 시뮬레이션합니다.
```bash
terraform plan -var="project_id=your-project-id" -out=tfplan.binary
```

### 3단계: 실제 배포 적용 (Apply)
시뮬레이션 완료 후, 준비된 플랜 바이너리를 주입하여 클라우드 자원을 배포합니다. (소요 시간 약 5분 ~ 7분)
```bash
terraform apply tfplan.binary
```

### 4단계: 배포 결과 확인 및 출력값 활용
배포가 완수되면 콘솔 화면에 에이전트 등록에 필요한 핵심 정보들이 자동으로 출력됩니다:
```bash
# 배포 성공 시 출력 예시:
service_account_email = "a2a-agent@your-project-id.iam.gserviceaccount.com"
cloud_run_url         = "https://a2a-router-2zrbh4cqea-uc.a.run.app"
agent_card_url        = "https://a2a-router-2zrbh4cqea-uc.a.run.app/.well-known/agent-card.json"
```
출력된 `agent_card_url`을 제미나이 엔터프라이즈 에이전트 갤러리에 그대로 복사하여 등록하면 모든 세팅이 완료됩니다!
