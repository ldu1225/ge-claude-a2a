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

### 📦 E. 테라폼 생성 14대 GCP 리소스 명세 (GCP Resource Catalog)

본 IaC 패키지가 배포될 때 구글 클라우드 프로젝트 내부에 **물리적으로 생성되는 14개의 핵심 리소스 블록**과 아키텍처적 명세는 다음과 같습니다:

| 번호 | 테라폼 리소스 블록 (`Type.Name`) | GCP 실물 자원명 (Physical Resource) | 역할 및 도입 목적 (Architectural Purpose) |
| :---: | :--- | :--- | :--- |
| **1** | `google_service_account.a2a_agent` | A2A 전용 서비스 계정 (`a2a-agent`) | 에이전트 가상 머신 및 라우터가 키(Key) 없이 구글 API와 안전하게 인증하는 핵심 Identity 주체 |
| **2** | `google_project_iam_member.vertex_ai_user` | IAM Platform User 권한 | 에이전트(Claude Code)가 구글 보안망 내부에서 Vertex AI Claude/Gemini API를 호출할 수 있는 권한 |
| **3** | `google_project_iam_member.workstation_op_viewer` | IAM Workstation Operation Viewer 권한 | 가상 머신의 동작 상태를 안전하게 조회하기 위한 운영 관측 권한 |
| **4** | `google_artifact_registry_repository.images` | Artifact Registry 저장소 (`a2a-agent-images`) | Claude 개발 환경이 튜닝된 커스텀 워크스테이션 도커 이미지 저장소 |
| **5** | `google_compute_subnetwork.workstations` | VPC 사설 서브넷 (`a2a-ws-subnet`) | 가상 머신을 외부 공인 인터넷으로부터 차단하고 사설 망에 가두는 보안 서브넷 |
| **6** | `google_compute_router.router` | Cloud Router (`a2a-ws-router`) | 사설 서브넷에 바인딩되어 아웃바운드 인터넷 통신 경로를 제공하는 사설 라우터 |
| **7** | `google_compute_router_nat.nat` | Cloud NAT 게이트웨이 (`a2a-ws-nat`) | 사설 VM이 외부 패키지(npm 등)를 다운로드할 수 있게 하되, 외부 침입은 100% 차단하는 일방통행 게이트 |
| **8** | `google_workstations_workstation_cluster.cluster` | Workstation Cluster (`ai-agents-cluster`) | 사용자별 가상 머신들이 기동되는 물리적 보안 클러스터 제어 구역 |
| **9** | `google_workstations_workstation_config.config` | Workstation Config (`a2a-agent-config`) | 머신 사양(`e2-standard-4`), 10분 유휴 자동 종료, 볼륨 설정 등을 중앙 통제하는 정책 설정서 |
| **10** | `google_cloud_run_v2_service.router` | Cloud Run 서비스 (`a2a-router`) | 사용자별 통신을 감지하여 꺼진 가상 머신을 깨우고 트래픽을 중계하는 중추 라우터 프록시 |
| **11** | `google_cloud_run_v2_service_iam_member.public` | Cloud Run Invoker 권한 | 제미나이 에이전트 플랫폼이 라우터 API 엔드포인트를 호출할 수 있도록 인보커 권한 개방 |
| **12** | `google_project_iam_member.artifactregistry_reader` | IAM Artifact Registry Reader 권한 | 가상 머신이 부팅될 때 Artifact Registry의 커스텀 보안 이미지를 정상적으로 읽어올 수 있도록 허용 |
| **13** | `google_service_account_iam_member.agent_self_actor` | IAM Service Account User 권한 (ActAs) | 가상 머신 런타임이 에이전트 서비스 계정의 자격을 대행(Impersonation)할 수 있도록 허용하는 권한 |
| **14** | `google_project_iam_member.workstation_admin` | IAM Workstations Admin 권한 | 라우터가 관리자 자격으로 가상 머신들을 자율적으로 켜고 끄며 토큰을 안전하게 발행할 수 있는 제어 권한 |

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

> **💡 꿀팁: default VPC 네트워크가 삭제된 보안/폐쇄망 환경 배포법**
> 대기업이나 금융권 등 보안이 철저한 GCP 프로젝트에서는 기본 `default` 네트워크가 아예 지워져 있는 경우가 많습니다. 이 경우 테라폼 실행 시 아래와 같이 본인들이 사용하는 **실제 VPC 네트워크 이름을 변수로 추가 주입**해 주면 아무런 에러 없이 100% 완벽히 생성됩니다:
> ```bash
> # CLI 명령어로 직접 주입하는 방법
> terraform plan -var="project_id=your-project-id" -var="network=고객사의_VPC_이름" -out=tfplan.binary
> 
> # 또는 terraform.tfvars 파일을 생성하여 영구 기입해두는 것을 권장합니다 (추천)
> ```

### 3단계: 실제 배포 적용 (Apply)
시뮬레이션 완료 후, 준비된 플랜 바이너리를 주입하여 클라우드 자원을 배포합니다. (소요 시간 약 5분 ~ 7분)
```bash
terraform apply tfplan.binary
```

### 4단계: 배포 결과 확인 및 에이전트 등록
배포가 완수되면 콘솔 화면에 에이전트 등록에 필요한 핵심 정보들이 자동으로 출력됩니다:
```bash
# 배포 성공 시 출력 예시:
service_account_email = "a2a-agent@your-project-id.iam.gserviceaccount.com"
cloud_run_url         = "https://a2a-router-2zrbh4cqea-uc.a.run.app"
agent_card_url        = "https://a2a-router-2zrbh4cqea-uc.a.run.app/.well-known/agent-card.json"
```
제미나이 엔터프라이즈 관리자 콘솔 등록을 완료하려면:
1. 웹 브라우저에서 출력된 `agent_card_url` 주소로 접속해 **출력된 JSON 텍스트 내용 전체를 복사**합니다.
2. **구글 워크스페이스 관리자 콘솔** > **앱** > **Gemini** > **에이전트 플랫폼**으로 이동하여 새 에이전트 추가 버튼을 누르고, 복사한 **JSON 텍스트를 입력창에 직접 붙여넣기(Paste)** 하거나 업로드하여 등록을 완료합니다.


---

## 💰 4. 비용 최적화 및 과금 포인트 분석 (Cost & Billing Analysis)

대기업 IT 부서 및 재무팀(CFO)이 인프라를 도입할 때 가장 민감하게 검증하는 **과금 포인트와 비용 절감 메커니즘**을 투명하게 분석한 명세서입니다. 본 아키텍처는 **유휴 자원 낭비를 100% 차단하도록 고안**되어 있습니다.

### 🔌 A. 3대 핵심 과금 요소 (Cost Factors)

#### **1. 컴퓨팅 가상 머신 비용 (Compute Engine VM - e2-standard-4)**
* **과금 방식:** 가상 머신이 켜져 있는 시간(초 단위)에 비례하여 과금됩니다. (유휴 대기 시간 제외)
* **하드웨어 가격:** 서울 리전 `e2-standard-4` (4 vCPU, 16GB RAM) 기준 시간당 약 `$0.15` 내외입니다.
* **💡 비용 최적화 (자동 종료):** 
  본 아키텍처는 **[10분 유휴 자동 종료(Idle Timeout)]**와 **[2시간 최대 가동 시간 제한(Running Timeout)]** 정책이 중앙 통제 설정에 박혀 있습니다. 
  개발자가 브라우저 창을 닫고 자리를 비우거나 퇴근하면, 가상 머신이 10분 만에 **자동으로 정지(Stop) 상태**로 돌입합니다. **정지 상태가 되면 가상 머신 컴퓨팅 비용은 0원($0.00)**이 되어 불필요한 과금이 완벽히 차단됩니다.

#### **2. 영구 디스크 스토리지 비용 (Persistent Disk - Balanced PD 100GB)**
* **과금 방식:** 가상 머신이 꺼져 있더라도 개발자가 작업한 소스코드, 환경 설정, 패키지들이 저장된 디스크는 영구 보존되어야 하므로 **24시간/30일 내내 지속 과금**됩니다.
* **저장소 가격:** 균형성 영구 디스크(Balanced PD) 기준 GB당 월 약 `$0.10`입니다. (100GB 기준 **월 약 `$10.00`** 내외)
* **특징:** 개발 성과물이 누적되어 쌓이는 곳이 바로 이 디스크입니다. 작업이 쌓이더라도 디스크 크기가 고정(100GB)되어 있다면 **추가 과금 없이 고정 비용만 청구**됩니다. 디스크 보존 비용은 클라우드 자원 중 가장 저렴하므로 안심하셔도 됩니다.

#### **3. 서버리스 라우터(Cloud Run) 및 Vertex AI API 비용**
* **과금 방식:** 100% 사용량 비례(Pay-as-you-go) 과금입니다. 켜두었다고 해서 기본요금이 나가지 않습니다.
* **Cloud Run 라우터:** 제미나이에서 신호가 들어와 트래픽을 처리하는 0.x초 동안만 분할 과금되므로, 1인 기준 **월 약 `$0.50` 미만**으로 사실상 무료에 가깝습니다.
* **Vertex AI (Claude 3.5 Sonnet):** 개발자가 에이전트와 대화하며 읽고 쓴 토큰 수에 비례해서만 청구됩니다. 대화를 나누지 않는 밤시간이나 주말에는 **기본 대기 비용이 0원**입니다.

---

### 🏢 B. 1인 개발자 기준 한 달 실제 과금 시뮬레이션 (Simulation)

주 5일, 일 8시간 근무하는 일반적인 개발자(월 160시간 가동)를 기준으로 시뮬레이션한 리얼 월 요금 분석표입니다:

| 과금 요소 (Billing Items) | 가동 기준 (Usage Details) | 월 예상 비용 (USD) | 설명 |
| :--- | :--- | :---: | :--- |
| **가상 머신(Compute VM)** | 160시간 가동 (8시간 * 20일) | **약 $24.00** | 일을 안 하는 밤시간, 주말에는 자동 정지되어 과금 차단 |
| **GCP 워크스테이션 수수료** | 160시간 가동 (시간당 $0.05) | **약 $8.00** | 구글 클라우드 가상 IDE 플랫폼 사용 관리 비용 |
| **영구 디스크 (Balanced 100GB)** | 24시간 * 30일 상시 보존 | **약 $10.00** | 가상 머신이 꺼져도 코드를 영구 보존하는 비용 (고정비) |
| **Cloud Run & API 통신** | 사용량 비례 연동 | **약 $3.00** | 일회성 호출 및 내부 라우팅 서버 가동 비용 |
| **최종 예상 합계 (Total)** | **1인 개발자당 / 월 기준** | **약 $45.00 (한화 약 6만 원대!)** | **전통적인 24시간 가동 서버 대비 70% 비용 절감!** |

> 💡 **재무팀을 위한 요약:**
> 본 패키지는 **"개발자가 실제로 일하는 시간(시간당 약 200원)"**에만 컴퓨팅 비용이 나가고, 자리를 비우면 즉시 초저가 고정 스토리지 비용(월 1만 원대)으로 스위칭되는 극도의 가성비 비용 모델을 가지고 있습니다. 대기업 대규모 배포 시에도 예산 낭비 걱정 없이 가장 안전하게 통제할 수 있습니다.
