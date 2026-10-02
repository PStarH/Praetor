<p align="center">
  <a href="https://github.com/PStarH/Commander/actions/workflows/ci.yml?query=branch%3Amaster"><img src="https://img.shields.io/github/actions/workflow/status/PStarH/Commander/ci.yml?branch=master&style=flat-square&label=CI&logo=github" /></a>
  <img src="https://img.shields.io/github/license/PStarH/Commander?style=flat-square&color=EAB308" />
</p>

<h1 align="center">Commander</h1>
<p align="center"><strong>Coding / DevOps AI エージェントのための承認と状態復旧プレーン</strong></p>
<p align="center">
  <em>重複変更の防止 · ネットワーク切断・タイムアウトからの安全復旧 · 電子署名付き監査証跡</em>
</p>

> **ステータス: Alpha。** Commander はオープンソースの評価システムおよびパイロットフレームワークです。現時点では本番稼働認証を受けていません。[GitHub パイロット境界](docs/pilot/github/README.md) および [ENTERPRISE_READINESS.md](ENTERPRISE_READINESS.md) を参照してください。

<p align="center">
  <a href="#クイックスタート"><img src="https://img.shields.io/badge/TRY_NOW-000?style=for-the-badge" /></a>
  <a href="#ai-エージェントが直面する分散システムの課題"><img src="https://img.shields.io/badge/WHY_COMMANDER-000?style=for-the-badge" /></a>
  <a href="https://pstarh.github.io/commander-docs/ja/"><img src="https://img.shields.io/badge/DOCS-000?style=for-the-badge" /></a>
</p>

---

## AI エージェントが直面する分散システムの課題

```
   ┌────────────────────────────────────────────────────────┐
   │          AI エージェントフレームワーク / LLM            │
   │  Claude Code · Cursor · OpenAI Agents · LangGraph      │
   └──────────────────────────┬─────────────────────────────┘
                              │ 1. アクション提案（書き込みトークンを持たない）
                              ▼
   ┌────────────────────────────────────────────────────────┐
   │             Commander 統治・復旧コントロールプレーン    │
   │  ┌─────────────────────────┐ ┌──────────────────────┐  │
   │  │ 再試行前事前照会 (冪等性)│ │ 2段階暗号学的承認    │  │
   │  │ (Query-Before-Retry)    │ │ (Cryptographic Hash) │  │
   │  └─────────────────────────┘ └──────────────────────┘  │
   │  ┌─────────────────────────┐ ┌──────────────────────┐  │
   │  │ 永続 PostgreSQL Kernel  │ │ 改ざん検知署名証跡   │  │
   │  │ (クラッシュ安全 Lease)  │ │ (Ed25519 Signed JWS) │  │
   │  └─────────────────────────┘ └──────────────────────┘  │
   └──────────────────────────┬─────────────────────────────┘
                              │ 2. 統治された書き込み・自動補償トランザクション
                              ▼
   ┌────────────────────────────────────────────────────────┐
   │             外部インフラストラクチャ                   │
   │    GitHub (PR/Issue) · Kubernetes · クラウド API       │
   └────────────────────────────────────────────────────────┘
```

AI エージェント（Claude Code、OpenAI Agents SDK、社内独自コーディングエージェントなど）が外部変更（GitHub Pull Request の作成、Kubernetes デプロイのロールバック、インフラの変更など）を試みる際、**接続の切断や Worker の再起動によって世界は曖昧な状態に陥ります**：

書き込みは実際に行われたのか？ 何回実行されたのか？ 実際に何がコミットされたのか？

盲目的な再試行は、PR の重複作成、二重トランザクション、状態の破損を引き起こします。諦めて停止すれば、孤立した外部副作用が放置されます。

| 課題 | ナイーブなエージェント実行 | Commander による統治されたアクション |
| --- | --- | --- |
| **レスポンス喪失**（PR 作成時の 504 タイムアウト等） | 再計画または盲目的再試行 → **重複 PR や不正変更の発生** | **再試行前事前照会（Query-Before-Retry）**: 再試行前にアクション識別子でリモート結果を確認 |
| **実行中の Worker クラッシュ** | 状態喪失または最初から再実行され、外部副作用が孤立 | **永続 PostgreSQL Kernel**: ステップリースを安全に回収し、新しい Worker が安全に再開 |
| **クレデンシャル露出リスク** | エージェントプロセスが書き込み API キー / トークンを直接保持 | **厳格な権限境界**: エージェントには提案（Propose）権限のみを付与、書き込みトークンは Worker 側に隔離 |
| **人間による承認サインオフ** | テキストプロンプトまたは検証不能なボタン | **暗号結合**: 承認時に不変の要求ダイジェストとポリシーのスナップショットをロック |
| **監査とフォレンジック** | 揮発性のコンソールログ | **Ed25519 署名証跡**: 独立検証可能な JWS 署名付きレシートを発行 |
| **ロールバック / 取り消し** | その場しのぎのスクリプトまたは復旧不能 | **統治された補償**: 別途承認された権限バインディングと専用レシートが必要 |

詳細な技術解説を読む: [なぜ AI エージェントの外部アクション再試行は安全ではないのか](docs/content/why-retrying-ai-agent-external-actions-is-unsafe.md)。

---

## Commander とは

エージェントが Pull Request の作成を要求します。人間がそれを承認します。GitHub は書き込みを受け付けましたが、Worker がレスポンスを受信する前に切断されました。操作は本当に成功したのか？ 次の Worker は何をすべきか？

Commander は、承認された要求とその実行状態をエージェントの外部に一元管理します。GitHub アダプターはレスポンス喪失後も一致する結果を照会し、証拠が曖昧な場合は未解決状態を安全に保持し、マージされていない PR を閉じる場合も別途承認された補償アクションを通じてのみ実行します。

最初のパイロットは意図的に限定されています：**同一リポジトリ内の既存ブランチからの PR 作成**。コードの生成や push、PR の自動マージ、本番環境へのデプロイは行いません。ブランチの内容は引き続き GitHub 上でのレビューとチェックが必要です。

- [GitHub パイロットの実行](docs/pilot/github/README.md): 提案 → 承認 → 検査 → 別途承認によるクローズ
- [なぜ GitHub 標準権限や Actions 承認だけでは不十分なのか？](docs/pilot/github/native-controls.md): ネイティブの制御で十分な場合も多くあります。統一されたアクション識別、復旧、監査証跡に明確な価値がある場合に Commander を使用してください。
- [セキュリティ境界と制限事項](docs/pilot/github/threat-model.md): 相関マーカーは電子署名ではなく、外部の副作用は必ずしも完全な Exactly-Once を保証できません。

アダプター契約と CLI は自動化されたローカルテストを備えています。手動トリガーの CI ジョブは、単一のサンドボックスリポジトリに対して実際の Gateway、Worker、PostgreSQL を実際の GitHub API 上で実行します。テストプロキシが作成レスポンスを切断または保持し、Worker が強制終了されて再起動し、新しい Worker が重複 PR を作成することなく既存の PR を検出します。失われたレスポンスはテストプロキシによって注入されたものであり、自然なネットワーク障害ではありません。本番運用の保証や採択の推奨を意味するものではありません。既存のローカルエージェントランタイムと読み取り専用レビューツールも以下から利用可能です。

---

## ランタイムパス

GitHub パイロットは、現在 **alpha** 段階の永続サーバーパスである **Enterprise Gateway** を使用します。**Local CLI** は独立したローカルエージェントランタイムであり、そのシミュレーションデモは Gateway の管理された書き込み動作を証明するものではありません。

|                    | Local CLI                                                                     | Enterprise Gateway                                                     |
| ------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **エントリ**       | `commander review --real`（最初のプロバイダー検証）；その他のコマンドは alpha | `POST /v1/runs`（`apps/api` 経由）                                     |
| **状態管理**       | ローカル SQLite / JSON (`.commander_state/`)                                  | Postgres kernel (`runs`/`steps`/`events`/outbox/leases)                |
| **認証**           | なし（単一ユーザー）                                                          | `COMMANDER_API_KEY` + JWT テナントクレーム                             |
| **マルチテナント** | なし（暗黙の `__default__`）                                                  | Alpha — kernel RLS + テナント対応シングルトン；ストレージ分離は opt-in |
| **永続 Kernel**    | なし                                                                          | あり（本番環境 / Postgres DSN 設定時に自動有効化）                     |
| **ステータス**     | Alpha ローカル評価ツール — 本番未対応                                         | Alpha — 実際のバックエンドでの実戦検証前                               |

以下の初回ユーザーパスは、ソースコードに基づく **E0 シミュレーションデモ** です。認証情報は不要で、プロバイダーや外部ターゲットシステムへの書き込みを行わず、プロバイダーを利用する Local CLI や E1 Enterprise Gateway パイロットパスとは完全に分離されています。clone、install、build はマシン上にチェックアウト、依存関係キャッシュ、ビルド成果物を書き込みます。

---

## クイックスタート

### ⚡ 4つの探索パス（60秒でクイック体験）

| パス | コマンド | 検証内容 |
| --- | --- | --- |
| **1. ゼロ依存シミュレーション** | `pnpm demo:l4-a` | マルチエージェント審議トポロジ、5層品質ゲート評価、インメモリ完結実行（APIキー不要） |
| **2. 実プロバイダー読み取り専用コードレビュー** | `pnpm exec tsx packages/core/src/cliEntry.ts review --commit HEAD --real --provider=openai` | 任意の LLM キーを使用し、ローカル Git diff を品質ゲート付きで読み取り専用レビュー |
| **3. Web インタラクティブ管理コンソール** | `pnpm gui` | ブラウザダッシュボード (`:5173`) の起動：ライブトポロジ、DLQ 調査、承認キュー |
| **4. 統治アクションオフライン契約テスト** | `pnpm test:github:offline` | ネットワーク切断後の冪等性事前照会と2段階承認を検証する130件のオフラインアサーション |

### 📦 4行で簡単統合 (Python SDK)

```python
from commander_sdk import CommanderClient

# Commander 統治コントロールプレーンに接続
client = CommanderClient(base_url="http://localhost:4000")

# 再試行前事前照会と人間承認で保護された外部変更タスクをディスパッチ
run = client.runs.create(
    task="認証モジュールの diff をレビューし修正 PR を提案する",
    require_approval=True
)
print(f"タスク {run.run_id} 開始、承認待ちステータス: {run.approval_required}")
```

新しい GitHub アクションパスについては、[パイロットガイド](docs/pilot/github/README.md) を参照してください。認証情報不要の契約テスト、設定済み Gateway デモ、オプトインの実 GitHub アダプターテストが明確に分かれています。以下のローカルランタイムデモは独立したシミュレーション例です。そのアニメーションはローカル CLI の表示であり、GitHub の承認やレスポンス喪失復旧の録画ではありません。

<p align="center">
  <img src="docs/assets/commander-watch-demo.svg" alt="ローカル CLI ヘルプアニメーション。GitHub 復旧の録画ではありません。" width="100%">
</p>

### E0 シミュレーションデモの実行（初回推奨）

Node.js 22.x と pnpm 9 を使用します（Corepack が固定バージョンを選択します）。このライフサイクルはソースコードのチェックアウトから完全に動作します：

クローンと初期インストールには、GitHub およびパッケージレジストリへの通常のアクセスが必要です。`--offline` フラグはプロバイダーへのリクエストを行わないことを意味し、完全なオフラインインストールを意味するものではありません。

```bash
git clone https://github.com/PStarH/Commander.git
cd Commander
corepack enable
pnpm install --frozen-lockfile
pnpm build

pnpm exec tsx packages/core/src/cliEntry.ts --help
pnpm exec tsx packages/core/src/cliEntry.ts doctor --offline
pnpm demo:l4-a
```

`doctor --offline` は LLM プロバイダーに接続せずにローカルの前提条件を確認します。`demo:l4-a` はシミュレートされたインメモリ依存関係とループバックサーバーを使用し、実際のプロバイダー呼び出しや外部書き込みは行いません。デモはループバックサーバーを自己管理して終了時に自動停止するため、外部リソースの破棄コマンドは不要です。コマンドの正常終了により E0 のクリーンアップが完了します。

このパスの完了は開発・デモ用の検証結果にすぎません。公開パッケージのインストール、E1 の管理された書き込みの証明、あるいは Commander が本番対応であることを示すものではありません。

### 実プロバイダーによる読み取り専用コードレビュー（最初の実機検証）

```bash
# 明示的に 1 つのプロバイダーを選択
export OPENAI_API_KEY=sk-...
pnpm exec tsx packages/core/src/cliEntry.ts review \
  --commit HEAD --real --provider=openai

# または Anthropic を使用
export ANTHROPIC_API_KEY=sk-ant-...
pnpm exec tsx packages/core/src/cliEntry.ts review \
  --commit HEAD --real --provider=anthropic
```

このコマンドは指定された Git diff とローカルのレビューガイドラインを読み取り、選択されたプロバイダーに最大 15,000 文字の diff を送信し、レスポンスを 4,000 トークンおよび 8 MiB に制限します。Commander は 120 秒後にプロバイダー通信を中止し、JSON 解析前に 8 MiB を超えるレスポンス本文を拒否します。プロバイダーおよびモデルには実行ツールが付与されていないため、コマンドの実行、ファイルの編集、Web ブラウジング、またはターゲットシステムへの書き込みを開始することはできません。CLI 自体は固定された読み取り専用の `git diff` コマンドを実行し、システム一時ディレクトリ内のプロセス間レート制限状態を更新します。

出力には `source=real`、プロバイダー、モデル、エンドポイントホスト、プロンプトバイト数、切り詰められた diff の実際のカバレッジ割合、およびレスポンス上限が明記されます。認証情報の欠落、空の diff、プロバイダーエラー、タイムアウト、サイズ超過レスポンス、無効な構造化出力は非ゼロの終了ステータスで失敗し、シミュレーションレビューに静かにフォールバックすることはありません。

Diff とガイドラインはマシンから送信され、リポジトリの機密情報を含む可能性があり、プロバイダーの保持ポリシーの対象となります。実行前に [PRIVACY.md](PRIVACY.md) を確認してください。通常の `commander run`、`pnpm gui`、MCP、SDK、および Enterprise Gateway のフローはこの初回ユーザーパスには含まれず、読み取り専用または本番対応として提示してはなりません。

### Enterprise Gateway（alpha）

この初回ユーザーガイドでは、直接実行可能な Gateway コマンドをあえて記載していません。このパスには追加のシークレット、PostgreSQL、および運用管理が必要です。企業評価には、履歴サンプルのみを評価し外部ロールバックを行わない [Shadow パイロット Phase A](docs/pilot/shadow/README.md) を使用してください。ゲート管理された [ライブ書き込みリファレンス](docs/enterprise/quickstart.md) は [ENTERPRISE_READINESS.md](ENTERPRISE_READINESS.md) と併せて確認する必要があります。境界が定められた E1 デザインパートナーワークフローは、引き続き [ローンチレディネス・ランブック](docs/runbooks/design-partner-launch-readiness.md) によって管理されます。開発用 Gateway の起動は外部書き込みの承認や証明を意味するものではなく、共有マルチテナント利用は依然として alpha 段階です。

---

## 主な機能

### 推論エンジン（Deliberation Engine）

タスク分類、複雑度推定、トポロジ選択をすべて自動化。Commander はタスクを分類（CODING / RESEARCH / ANALYSIS / FACTUAL）し、複雑度を推定し、5 つの標準トポロジ（SINGLE、CHAIN、DISPATCH、ORCHESTRATOR、REVIEW）から選択します。1 行のタスクには 1 エージェントを使用し、リポジトリ全体の監査では最大 15 エージェントに分散展開できます。

### リアルタイムストリーミング（Live Streaming）

エージェントイベント、ツール呼び出し、設定されたゲート判定がターミナルまたは SSE エンドポイントにリアルタイムでストリーミングされます。事後ポーリングや実行後ログではありません。出力された作業トレースをステップごとに検査できます。

```
┌─ Deliberation ──────────────────────────────────────────────┐
│ Task: "audit this repo for security issues"                  │
│ Classification: ANALYSIS · Complexity: 7/10                  │
│ Topology: DISPATCH (3 agents)                                │
├─ Agent α (security-scanner) ─────────────────────────────────┤
│ [event] Scanning package.json for known CVEs...              │
│ [tool] npm audit · 2 critical, 5 moderate                    │
│ [gate] ACCURACY ✓ · COMPLETENESS ✓                           │
├─ Agent β (code-reviewer) ────────────────────────────────────┤
│ [event] Checking for hardcoded secrets...                    │
│ [tool] grep · found 1 potential secret in config.ts          │
│ [gate] SAFETY ⚠ · Potential secret detected                  │
├─ Agent γ (dependency-checker) ───────────────────────────────┤
│ [event] Analyzing license compliance...                      │
│ [tool] license-check · No GPL/AGPL dependencies              │
│ [gate] COMPLETENESS ✓ · ACCURACY ✓                           │
├─ Synthesizer ────────────────────────────────────────────────┤
│ Merging 3 agent outputs...                                   │
│ Leader synthesis · 4 findings, 2 critical                    │
└──────────────────────────────────────────────────────────────┘
```

### 25 のプロバイダーと自動フェイルオーバー

いずれか 1 つの API キーを設定するだけで、Commander がプロバイダーを自動検出し、障害発生時は設定されたチェーンに従ってフォールバックします。OpenAI → Anthropic → DeepSeek → Groq → Ollama — 順序を定義すれば、ルーティングは Commander が処理します。

OpenAI · Anthropic · Google · Azure · DeepSeek · GLM · MiMo · Xiaomi · Groq · Together · Perplexity · Fireworks · Replicate · Mistral · Cohere · OpenRouter · xAI · Anyscale · DeepInfra · Agnes · Ollama · vLLM · AWS Bedrock · StepFun · MiniMax

### 設定可能な品質ゲート（Quality Gates）

検証パイプラインが有効なパスにおいて、Commander は結果を返す前に以下の 5 つの設定されたチェックを実行します：

| ゲート | チェック内容 |
| ------------- | ------------------------------------------- |
| ハルシネーション (Hallucination) | LLM-as-Judge による捏造された事実の検出 |
| 整合性 (Consistency) | エージェント間の一致、自己矛盾の排除 |
| 完全性 (Completeness) | 必要なすべてのディメンションの網羅 |
| 正確性 (Accuracy) | ソース資料に基づく事実の正確性 |
| 安全性 (Safety) | コンテンツスキャンとプロンプトインジェクション検出 |

出力がいずれかの設定されたゲートに失敗した場合、システムは再試行するか、完全なコンテキストとともに失敗を報告します。

### 耐障害性と回復性（Resilience）

| 機能 | 実装 |
| ----------------- | ------------------------------------------------------------------ |
| サーキットブレーカー (Circuit Breakers) | 3 状態（CLOSED/OPEN/HALF-OPEN）、プロバイダー別エラー率追跡 |
| デッドレターキュー (Dead Letter Queue) | 追記専用 NDJSON、7 カテゴリ、リプレイ対応 |
| Saga 補償 (Saga Compensation) | 登録された補償ステップ；外部ロールバックは完全保証されません |
| チェックポインティング (Checkpointing) | SQLite + WAL、クラッシュ耐性復旧（目標 <5s） |
| セマンティックキャッシュ (Semantic Caching) | SHA-256 完全一致 + コサイン類似度による重複排除 |

### セキュリティ（Security）

AES-256-GCM 暗号化シークレット保管庫。プロセス内の改ざん検知 HMAC 監査チェーン（外部 WORM/KMS 証拠は準備中）。権能トークンによる RBAC。ISO 42001 / NIST AI RMF コンプライアンス**レポート足場**（レポート生成ツールであり、認証書ではありません）。レッドチームフレームワーク（47 シナリオ、8 攻撃カテゴリ）。リクエストコンテキストによるテナントスコープ（AsyncLocalStorage）；ストレージ層の分離はオプトイン — Enterprise Gateway、alpha。

### 自己最適化（Self-Optimization）

Thompson Sampling と Reflexion を用いたメタ学習器が、実行をまたいでエージェント構成を調整します。どのタスク種別にどのトポロジが最適か、どのプロバイダーが最速か、どのパラメータの組み合わせが最高品質の結果を生み出すかを学習します。5 回以上の記録された実行後に有効化されます。

---

## アーキテクチャ

```
                        ┌──────────────────────────────┐
                        │      DELIBERATION ENGINE      │
                        │  Task classification          │
                        │  Complexity estimation        │
                        │  Topology selection           │
                        └──────────┬───────────────────┘
                                   │
                        ┌──────────▼───────────────────┐
                        │       TOPOLOGY ROUTER          │
                        │  SINGLE · CHAIN · DISPATCH     │
                        │  ORCHESTRATOR · REVIEW          │
                        └──────────┬───────────────────┘
                                   │
                ┌──────────────────┼──────────────────┐
                ▼                   ▼                   ▼
         ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
         │   AGENT 1    │   │   AGENT 2    │   │   AGENT N    │
         │  LLM → Tool  │   │  LLM → Tool  │   │  LLM → Tool  │
         │  → Verify    │   │  → Verify    │   │  → Verify    │
         └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
                └──────────────────┼──────────────────┘
                                   ▼
                        ┌──────────────────────────────┐
                        │         SYNTHESIS              │
                        │  Merge · Resolve conflicts    │
                        └──────────┬───────────────────┘
                                   ▼
                        ┌──────────────────────────────┐
                        │       QUALITY GATES           │
                        │  Hallucination · Consistency  │
                        │  Completeness · Accuracy     │
                        │  Safety                      │
                        └──────────┬───────────────────┘
                                   ▼
                                RESULT
```

---

## Web コンソール

Commander には、視覚的監視、対話型エージェント操作、およびガバナンスのための Web ベース管理コンソールが含まれています：

```bash
# PostgreSQL と明示的な JWT_SECRET および ADMIN_PASSWORD が必要です（docs/deploy.md 参照）。
# :4000 で API を、:5173 で Web を起動し、ブラウザを開きます。
pnpm gui
```

`http://localhost:5173` を開きます。コンソールのルート一覧：

| ルート | ページ |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| `/`                          | ダッシュボード — 戦況報告、トークン傾向、リアルタイムトポロジ、エージェント名簿、ミッションボード |
| `/agents`                    | エージェント名簿 |
| `/missions`                  | ミッションボードと承認キュー |
| `/execution`                 | リアルタイム実行フィード |
| `/memory`                    | メモリブラウザと検索 |
| `/governance`                | 承認キューとポリシー設定 |
| `/security`                  | セキュリティ態勢 — ISO 42001 / NIST AI RMF **レポート足場**（レポートツールであり認証ではありません） |
| `/slo`                       | SLO パネル |
| `/chat`                      | エージェントのリアルタイムストリーミング対話インターフェース |
| `/dlq`                       | リプレイ対応デッドレターキュー管理 |
| `/audit`                     | 監査ログ |
| `/cost`                      | コストとトークンレポート |
| `/knowledge`                 | ナレッジベース |
| `/alerts`                    | アラート |
| `/onboarding`                | 初回オンボーディング |
| `/users`                     | ユーザー管理 |
| `/settings`, `/settings/sso` | 設定および OIDC/SSO シングルサインオン設定 |
| `/workflows`                 | ワークフロー一覧とスケジューリング |
| `/poc`                       | POC / デモビュー |
| `/research`                  | 調査ビュー |
| `/actions`                   | Action Gateway キュー（承認 / 却下 / 補償） |

`pnpm gui` の代わりに Compose の `web` プロファイルを使用する場合、同じコンソールが `http://localhost:3000` で提供されます。

---

## 信頼性目標

| 目標 | 基準 | 実装メカニズム |
| ------------------- | ---- | -------------------------- |
| チェックポイント復旧 | <5s  | SQLite + WAL               |
| プロバイダーフェイルオーバー | <10s | 自動フォールバックチェーン |
| Saga 補償 | <30s | 補償スケジューラー |
| DLQ 処理 | <60s | 追記専用 NDJSON、リプレイ対応 |

---

## ベンチマーク

> 以下のすべてのベンチマークは、**シミュレーション/スクリプト化されたハーネス**または **CI ベースライン**として実行されます。これらはテストハーネスを測定したものであり、本番の SLA や SOC 監査証拠ではありません。

| スイート | 対象 | 結果 |
| ----------------- | ----------------------------------------- | ------------------------------------------------- |
| カオスエンジニアリング (Chaos Engineering) | 200 合成 + 55 変異（計 255） | ハーネス登録；保持されたベースラインマトリクスを参照 |
| レッドチーム (Red Team) | 47 シナリオ、8 攻撃カテゴリ | 記載されたすべてのケースをブロック（シミュレーションハーネス） |
| AgentDojo | 12 セキュリティテストケース | 記載されたすべてのケースをブロック（シミュレーションハーネス） |
| GAIA Spine | コア機能ベンチマーク | クイック/オフライン実行をスケジューリング；完全なフィクスチャは準備中 |
| SLO | API 可用性 99.95%、P95 スケジュール <5s | CI ベースラインであり、本番 SLA ではありません |

詳細マトリクス: [BENCHMARK.md](BENCHMARK.md)

---

## ヘルスチェック

```bash
curl http://localhost:4000/health          # 基本 Liveness (200 / 503)
curl http://localhost:4000/health/detailed # 全コンポーネント詳細
curl http://localhost:4000/ready           # Readiness (DB, kernel, ストレージ)
curl http://localhost:4000/v1/health       # Gateway 限定 Readiness
curl http://localhost:4000/metrics         # Prometheus メトリクス
curl http://localhost:4000/system/status   # ランタイムモジュール概要
```

`/readyz` や `/livez` という別名は存在しません — API の準備完了確認は `/ready` です。

監視項目: メモリ、サーキットブレーカー、DLQ サイズ、チェックポイント遅延、保留中の補償、イベントバス滞留、プロバイダー可用性、ディスク容量。

---

## なぜ Commander か

エージェントのアクションが外部システムに到達した際、タイムアウトやクラッシュによって「実行されたのか」「何回実行されたのか」「どのようなペイロードだったのか」という 3 つの疑問が残ります。無暗な再試行は書き込みの重複を招き、諦めればアクションが喪失します。

Commander は、承認された要求とその実行状態をエージェントの外部に記録し、曖昧な応答の後に結果を照会し、証拠が決定的でない場合は明示的な未知状態にとどまります。副作用を取り消す処理は、個別に承認された別のアクションとして実行されます。

GitHub 標準の権限や Actions の承認などのネイティブ制御で十分な場合も多くあります。Commander は、エージェントとワーカーにわたって一元的な承認と復旧の記録を必要とするチーム向けに設計されています。

---

## ドキュメント

- [docs/architecture/](docs/architecture/000-index.md) — アーキテクチャ決定記録（ADR: V2 リソースモデル、ステートマシン、永続化、アイデンティティ、Effect Broker、Worker プロトコル、イベントセマンティクス）
- [docs/getting-started.md](docs/getting-started.md) — クイックスタートガイド
- [docs/deploy.md](docs/deploy.md) — デプロイガイド
- [docs/v2-migration-guide.md](docs/v2-migration-guide.md) — アーキテクチャ V2 移行ガイド
- [docs/slo.md](docs/slo.md) — SLO 定義
- [docs/content/why-retrying-ai-agent-external-actions-is-unsafe.md](docs/content/why-retrying-ai-agent-external-actions-is-unsafe.md) — 障害モデル解説：AI エージェントの外部アクション再試行が危険な理由
- [SECURITY.md](SECURITY.md) — セキュリティモデル、脅威モデル、コンプライアンス
- [BENCHMARK.md](BENCHMARK.md) — 完全なベンチマークマトリクスと測定手法
- [CHANGELOG.md](CHANGELOG.md) — リリース履歴

## パブリック境界とフィードバック

- **リアル vs シミュレーション:** オンボーディングタスクの結果は、UI/API が `source=real` を報告した場合にのみ実際の実行結果となります。フォールバックや POC の数値はシミュレーション/デモデータです。
- **プライバシー:** プロンプトは選択した LLM プロバイダーに送信される場合があり、ローカルトレース、メモリ、監査データ、オプションの OpenTelemetry エクスポートが永続化される場合があります。機密データを入力する前に [PRIVACY.md](PRIVACY.md) を確認してください。
- **バグ報告:** [GitHub Issues](https://github.com/PStarH/Commander/issues) に投稿してください。事前にプロンプト、ログ、設定、個人情報（PII）、シークレットをマスキングしてください。
- **質問や提案:** [GitHub Issues](https://github.com/PStarH/Commander/issues) をご利用ください。
- **セキュリティの脆弱性:** 公開 Issue を作成せず、[SECURITY.md](SECURITY.md) の手順に従って非公開で報告してください。

---

## ライセンス

MIT。[LICENSE](LICENSE) および [COPYRIGHT.md](COPYRIGHT.md) を参照。

---

<p align="center">
  <sub>外部システムに到達するエージェントアクションのための承認と復旧。</sub>
</p>
