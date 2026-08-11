# small-cms

データ型を実行時に登録すると、その CRUD エンドポイントが自動で生えてくる小さなヘッドレス CMS。
TypeScript + Deno で書かれていて、Deno Deploy 上で動く。

```
POST /__admin/resources  {"name": "articles", "fields": {...}}
  ↓
/articles と /articles/{id} が使えるようになる
```

管理画面が `/__admin` にあります。データ型の作成・変更・削除と、レコードの一覧・作成・編集・削除が
ブラウザからできます。

> [!WARNING]
> **`/__admin` に認証はありません。** サーバに到達できる人は誰でもリソースを作成・変更・削除でき、
> `DELETE /__admin/resources/articles` を投げれば記事が全部消えます。公開する場合は前段に認証を
> 置いてください。`src/app.ts` で `/__admin/*` に Hono のミドルウェアを1つ足すだけです。

## 用語

- **リソース** — ひとつのデータ型。`articles` や `tags` など。名前がそのまま URL のパスになる。
- **レコード** — リソースに属する1件のデータ。

## セットアップ

```bash
docker compose up -d
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/smallcms
deno task dev          # http://localhost:8000
```

テーブルは起動時に自動で作られるので、マイグレーションのコマンドはありません。

| タスク            | 内容                                                     |
| ----------------- | -------------------------------------------------------- |
| `deno task dev`   | 開発サーバ（ファイル変更で再起動）                       |
| `deno task start` | サーバ起動                                               |
| `deno task test`  | テスト（`DATABASE_URL` 未設定なら API テストはスキップ） |
| `deno task check` | 型チェック                                               |

### 動作確認

デプロイ先でも手元でも、全エンドポイントを一通り叩いて確認できます。

```bash
./scripts/smoke.sh https://small-cms.example.deno.net   # 省略時は http://localhost:8000
```

使い捨ての名前でリソースを作り、CRUD・バリデーション・ルーティングを確認してから削除します。
既存のリソースには触れません。終了コードは失敗した項目数です。

## 管理画面

`/__admin` を開くと、データ型とレコードを両方ブラウザから操作できます。

- **データ型** — 左のサイドバーに一覧。「+ 新しいデータ型」で作成、「スキーマ」タブでフィールドの
  追加・変更・削除、「データ型を削除」で削除（配下のレコードも消えます）。
- **レコード** — 「レコード」タブに一覧とページング。フォームはスキーマから生成されるので、
  `boolean` はチェックボックス、`datetime` は日時ピッカー、`json` はテキストエリアになります。
- バリデーションエラーは API が返した `details` をそのままフィールドの下に表示します。

素の HTML/CSS/JS が1ファイルに入っているだけで、ビルドステップも外部アセットもありません。API を
`fetch` で叩いているので、画面でできることは API でもすべてできます。

## API

### 管理 API — リソース自体の CRUD

| メソッド | パス                        | 内容                                   |
| -------- | --------------------------- | -------------------------------------- |
| `GET`    | `/__admin/resources`        | リソース一覧                           |
| `POST`   | `/__admin/resources`        | リソース作成（同名があれば 409）       |
| `GET`    | `/__admin/resources/{name}` | リソース定義取得                       |
| `PUT`    | `/__admin/resources/{name}` | スキーマ差し替え                       |
| `DELETE` | `/__admin/resources/{name}` | リソース削除（配下のレコードも消える） |

```bash
curl -X POST localhost:8000/__admin/resources -H 'content-type: application/json' -d '{
  "name": "articles",
  "fields": {
    "title":       { "type": "string",   "required": true },
    "body":        { "type": "string" },
    "views":       { "type": "number",   "default": 0 },
    "published":   { "type": "boolean",  "default": false },
    "publishedAt": { "type": "datetime" },
    "meta":        { "type": "json" }
  }
}'
```

- **`name` がそのまま URL のパスセグメントになります** — `"articles"` なら `/articles`。 `article` →
  `articles` のような自動複数形化はしません（英語の不規則変化で破綻するため）。 `^[a-z][a-z0-9_-]*$`
  にマッチする必要があります。
- 型は `string` / `number` / `boolean` / `datetime`（ISO 8601 文字列） / `json`（任意の
  JSON）の5種類。
- `required: true` のフィールドに `default` は指定できません。
- `id` / `createdAt` / `updatedAt` はサーバが管理するので、フィールド名に使えません。
- フィールドの宣言順は保持されます（将来の管理画面がその順で並べられるように）。

### データ API — レコードの CRUD

リソースを登録した時点で使えるようになります。

| メソッド | パス               | 内容     |
| -------- | ------------------ | -------- |
| `GET`    | `/{resource}`      | 一覧     |
| `POST`   | `/{resource}`      | 作成     |
| `GET`    | `/{resource}/{id}` | 1件取得  |
| `PUT`    | `/{resource}/{id}` | 全置換   |
| `PATCH`  | `/{resource}/{id}` | 部分更新 |
| `DELETE` | `/{resource}/{id}` | 削除     |

```bash
curl -X POST localhost:8000/articles -H 'content-type: application/json' \
  -d '{"title": "はじめての記事", "body": "本文"}'
```

```json
{
  "id": "6f1c...",
  "createdAt": "2026-08-11T01:23:45.678Z",
  "updatedAt": "2026-08-11T01:23:45.678Z",
  "title": "はじめての記事",
  "body": "本文",
  "published": false
}
```

一覧のクエリパラメータ:

| パラメータ | 既定値 | 内容                               |
| ---------- | ------ | ---------------------------------- |
| `limit`    | `20`   | 1〜100                             |
| `offset`   | `0`    |                                    |
| `order`    | `desc` | 作成日時の昇順 `asc` / 降順 `desc` |

```json
{ "items": [ ... ], "total": 42, "limit": 20, "offset": 0 }
```

その他: `GET /` は登録済みリソースの一覧、`GET /_health` は死活確認を返します。

### 挙動のルール

- **バリデーションは書き込み時のみ。** スキーマを変更しても既存レコードは書き換えず、保存された
  ままの内容を返します。マイグレーションなしでスキーマを変えられる代わりに、古いレコードには
  新しい必須フィールドが入っていないことがあります。
- **未知のフィールドは 400。** タイプミスが黙って保存されることはありません。
- `PUT` はレコードを丸ごと置き換えるので、省略した任意フィールドは既定値に戻ります。
  一部だけ変えたいときは `PATCH` を使ってください。
- `null` は任意フィールドを空にする意味になります。必須フィールドに `null` は 400。

### エラー

```json
{
  "error": {
    "code": "validation_error",
    "message": "Invalid record",
    "details": [{ "field": "title", "message": "is required" }]
  }
}
```

`validation_error` (400) / `not_found` (404) / `method_not_allowed` (405) / `conflict` (409) /
`internal_error` (500)。

## Deno Deploy へのデプロイ

1. Deno Deploy でこのリポジトリをリンクし、エントリポイントを `main.ts` にする。
2. ダッシュボードの Databases から Postgres を provision する（Prisma がホストする マネージド
   Postgres）。`DATABASE_URL` などの環境変数が自動で注入され、本番・プレビュー・
   ブランチごとに別々の論理データベースが割り当てられます。

Deno Deploy には SQLite ファイルを永続化する手段がない（ファイルシステムが非永続）ため、 Postgres
を使っています。Prisma Postgres は標準の `postgres://` 直接 TCP 接続に対応しているので、 Prisma ORM
は不要で、`npm:postgres` がそのまま繋がります。

環境変数:

| 変数                    | 既定値   | 内容                         |
| ----------------------- | -------- | ---------------------------- |
| `DATABASE_URL`          | （必須） | Postgres の接続 URL          |
| `DATABASE_POOL_MAX`     | `5`      | コネクションプールの上限     |
| `RESOURCE_CACHE_TTL_MS` | `30000`  | リソース定義のキャッシュ TTL |

## 設計メモ

- **リソース定義はデータであって DDL ではない。** 全リソースの全レコードが `records.data`
  （`jsonb`）に入ります。`POST /__admin/resources` がリクエスト中に `CREATE TABLE` を走らせずに
  済み、スキーマ変更が1行の UPDATE で終わります。SQL を実行時に組み立てる箇所はありません。
- **リソース定義はプロセス内にキャッシュされる。** Deno Deploy は複数のインスタンスを走らせるので、
  あるインスタンスで作成・変更したリソースが他のインスタンスに反映されるまで最大
  `RESOURCE_CACHE_TTL_MS` かかります。
- **依存は Hono と `npm:postgres` の2つだけ。** どちらも依存を持ちません。Hono がルーティング・
  CORS・エラーハンドリングを担い、バリデーションと DB アクセスはフレームワークに依存しない
  素の関数のままです（`src/schema.ts` は DB も HTTP も知りません）。テストのアサーションは Deno
  組み込みの `node:assert/strict` です。
- **ルーティングは「具体的なものから先に」登録する。** レコードのエンドポイントがルート直下
  （`/:resource`）にあるため、他のすべてのルートは先に登録されないと曖昧になります。メソッド違いに
  405 を返しているのも登録順によるもので、メソッド別のハンドラの後ろに `app.all` を置いています。
