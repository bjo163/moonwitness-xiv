# MoonWitness

![MoonWitness — every model, one board](packages/assets/brand/readme-banner.svg)

<p align="center">
  <a href="https://pnpm.io"><img alt="pnpm 11.17" src="https://img.shields.io/badge/pnpm-11.17.0-F69220?logo=pnpm&logoColor=white" /></a>
  <a href="https://nodejs.org"><img alt="Node.js 22" src="https://img.shields.io/badge/Node.js-22-5FA04E?logo=nodedotjs&logoColor=white" /></a>
  <a href="https://www.typescriptlang.org"><img alt="TypeScript strict" src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white" /></a>
  <a href="https://www.postgresql.org"><img alt="PostgreSQL 16" src="https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white" /></a>
  <a href="https://fastify.dev"><img alt="Fastify 5" src="https://img.shields.io/badge/Fastify-5-000000?logo=fastify&logoColor=white" /></a>
  <a href="https://nextjs.org"><img alt="Next.js 16" src="https://img.shields.io/badge/Next.js-16-000000?logo=nextdotjs&logoColor=white" /></a>
  <img alt="Status 1.0.0-rc.1" src="https://img.shields.io/badge/status-1.0.0--rc.1-2ea44f" />
</p>

**MoonWitness** adalah monorepo TypeScript untuk aplikasi bisnis _metadata-driven_. Model
dideklarasikan sekali di addon; `@moonwitness/orm` menurunkan tipe, validasi, tabel, relasi, hak
akses, REST/JSON-RPC, dan tampilan data dari deklarasi yang sama. API, Board, audit, job queue, dan
operasi produksi bergerak dari satu sumber kebenaran.

> **Status rilis:** `1.0.0-rc.1` · [Changelog](CHANGELOG.md) · [Master Roadmap](ROADMAP.md) ·
> [Kebijakan kompatibilitas](docs/engineering/compatibility.md)

Mulai cepat: [Quickstart](#quickstart) · [Panduan developer](docs/guide/index.md) ·
[Arsitektur](#arsitektur) · [Kontrak API](docs/guide/reference/api.md) ·
[WhatsApp gateway](docs/operations/whatsapp.md)

## Daftar isi

- [Sorotan](#sorotan)
- [Quickstart](#quickstart)
- [Arsitektur](#arsitektur)
- [Peta workspace](#peta-workspace)
- [Mesin model dan addon](#mesin-model-dan-addon)
- [Model bisnis bawaan](#model-bisnis-bawaan)
- [API dan data](#api-dan-data)
- [Autentikasi dan keamanan](#autentikasi-dan-keamanan)
- [Job queue, scheduler, dan outbox](#job-queue-scheduler-dan-outbox)
- [Board admin](#board-admin)
- [WhatsApp gateway](#whatsapp-gateway)
- [Perintah penting](#perintah-penting)
- [Kualitas dan CI](#kualitas-dan-ci)
- [Deploy dan operasi](#deploy-dan-operasi)
- [Dokumentasi](#dokumentasi)
- [Generated workspace reference](#generated-workspace-reference)

## Sorotan

| Pilar               | Yang didapat                                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Model deklaratif    | `defineModel` menghasilkan tipe, validasi, kolom, constraint, relasi, dan metadata UI dari satu deklarasi.                 |
| Addon transaksional | Model, seed, menu, akses, dan upgrade hook dipasang dalam satu transaksi tanpa SQL migration manual.                       |
| API generik         | REST CRUD dinamis dan JSON-RPC 2.0 dengan filter Polish notation, cursor pagination, dan audit otomatis.                   |
| Board data-driven   | Next.js App Router merender daftar, form, filter, dan detail record dari metadata API.                                     |
| Aman secara default | RBAC per grup, batas multi-company, redaksi rahasia, serta audit dan outbox dalam transaksi yang sama.                     |
| Siap operasi        | Job queue ber-lease, cron scheduler, metrics, health probe, backup/restore drill, dan image non-root dengan filesystem RO. |

## Quickstart

Prasyarat: **Node.js 22**, **pnpm 11.17**, dan **Docker Compose**.

```bash
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
docker compose up -d postgres
pnpm build
pnpm dev
```

Isi `.env` minimal:

- `JWT_SECRET` — string acak minimal 32 karakter dan persisten. Buat dengan:

  ```bash
  node --input-type=module -e "import { randomBytes } from 'node:crypto'; console.log(randomBytes(48).toString('base64url'))"
  ```

- `SUPERADMIN_PASSWORD` — password awal `superadmin`; hanya diterapkan selama akun belum punya hash
  di database.

`pnpm dev` menjalankan API, Board, dan outbox worker sekaligus. `docker compose up -d` tanpa nama
service juga menyalakan OmniRoute, gateway LLM dev-only di `127.0.0.1:20128`; gunakan
`docker compose up -d postgres` bila tidak diperlukan.

| Endpoint  | Default                        | Fungsi                                    |
| --------- | ------------------------------ | ----------------------------------------- |
| Board     | `http://localhost:5173`        | homepage publik, login, dan Board admin   |
| API       | `http://localhost:3000`        | REST `/api/*` dan JSON-RPC `/jsonrpc`     |
| Readiness | `http://localhost:3000/readyz` | HTTP 200 berarti proses dan database siap |
| Liveness  | `http://localhost:3000/livez`  | proses hidup, tanpa pemeriksaan database  |

Login lokal memakai username `superadmin` dan password yang Anda isi di `.env`. Seed berisi company,
partner, negara, dan contoh data lain untuk eksplorasi; jangan dipakai di production.

Panduan langkah demi langkah, termasuk tes PostgreSQL terisolasi, ada di
[quickstart](docs/guide/tutorials/quickstart.md).

## Arsitektur

```mermaid
flowchart LR
  B["Board<br/>Next.js · :5173"]
  A["API<br/>Fastify 5 · :3000"]
  O["@moonwitness/orm<br/>model · addon · domain query"]
  J["Worker · scheduler · outbox"]
  D[("PostgreSQL 16")]
  W["GoWA gateway<br/>(hosted)"]

  B -->|"/api · /auth · /jsonrpc"| A
  A --> O
  O --> D
  A --> J
  J --> D
  A <-->|"REST + webhook"| W
```

- **Board** memakai `@moonwitness/client` dan mem-proxy request same-origin ke API.
- **API** memasang addon secara programmatic saat startup, lalu melayani REST dinamis, JSON-RPC,
  auth, admin, dan command worker.
- **`@moonwitness/orm`** adalah mesin model/query; `orm-base` menyediakan model dan seed dasar,
  sedangkan `@moonwitness/types` menjadi kontrak lintas package.
- **Queue, scheduler, dan outbox** berada di `@moonwitness/jobs` dan memakai database yang sama,
  bukan state di memori.
- **`@moonwitness/ui` dan `@moonwitness/assets`** tidak menjadi dependensi API; keduanya melayani
  Board, katalog, dan dokumentasi.

Diagram dependency workspace, relasi model, auth refresh, jobs/outbox, dan instalasi addon tersedia
di [diagram arsitektur](docs/architecture/diagrams/README.md); penjelasan batas komponen ada di
[arsitektur sistem](docs/guide/explanations/architecture.md).

## Peta workspace

### Aplikasi

| Workspace                                     | Peran                                                                      |
| --------------------------------------------- | -------------------------------------------------------------------------- |
| `@moonwitness/api` (`apps/api`)               | Fastify API: REST dinamis, JSON-RPC 2.0, auth, admin, dan command worker.  |
| `@moonwitness/board` (`apps/board`)           | Next.js App Router: homepage publik dan Board admin dari origin yang sama. |
| `@moonwitness/docs` (`apps/docs`)             | Portal dokumentasi dan halaman desain berbasis Vite.                       |
| `@moonwitness/ui-catalog` (`apps/ui-catalog`) | Katalog statis interaktif untuk komponen `@moonwitness/ui`.                |

### Paket

| Lapisan           | Paket                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Model dan kontrak | `orm`, `orm-base`, `types`                                                                                               |
| Addon domain      | `orm-organization`, `orm-request`, `orm-workflow`, `orm-notification`, `orm-integration`, `orm-knowledge`, `orm-storage` |
| Runtime           | `auth`, `jobs`, `logger`, `local-ai`                                                                                     |
| Klien dan UI      | `client`, `ui`, `assets`                                                                                                 |
| Konten            | `knowledge`, `corpus`, `research`                                                                                        |
| Tooling           | `eslint-config`                                                                                                          |

API memasang addon `base`, `auth`, `jobs`, `integration`, `whatsapp`, `request`, `notification`,
`organization`, `workflow`, dan `knowledge`. Inventaris lengkap beserta script tiap workspace ada di
[generated workspace reference](#generated-workspace-reference).

## Mesin model dan addon

`@moonwitness/orm-base` hanya mendeklarasikan model, manifest, dan data. Field cukup ditulis sekali;
mesin `@moonwitness/orm` menghasilkan tipe TypeScript, validasi, kolom database, constraint, relasi,
dan metadata view. Field `id`, `active`, timestamp, serta UID pembuat/pengubah diwarisi otomatis.

```ts
export const User = defineModel('base.user', {
  table: 'users',
  fields: {
    login: fields.string({ required: true, unique: true }),
    password: fields.password(),
    partner: fields.belongsTo(Partner, { required: true, unique: true }),
    role: fields.enum(['system', 'superadmin', 'user'], { default: 'user' }),
  },
});

export const manifest = defineAddon({
  name: 'base',
  version: '1.0.0',
  models: [
    Country,
    Currency,
    Language,
    Company,
    Partner,
    User,
    Tag,
    TagLink,
    Attachment,
    Activity,
    Sequence,
  ],
  data,
});
```

API memanggil `await installAddons(db, [manifest, ...])`. Installer mengurutkan dependensi
addon/model, membuat tabel, menambah kolom yang aman, dan memasang seed dalam satu transaksi. Tidak
ada `schema.ts`, SQL migration, atau hook instalasi pada addon.

Instalasi bersifat _additive_: kolom lama tidak dihapus, diganti nama, atau diubah tipenya otomatis.
Field wajib tanpa default atau field unik pada tabel berisi data ditolak; lakukan backfill eksplisit
terlebih dahulu. Relasi opsional dapat ditambahkan dengan nilai kosong pada record lama. Jalankan
instalasi dari satu proses saat mengubah skema; replica API/worker memakai PostgreSQL advisory lock
saat startup.

### Seed stabil

```ts
seed(User, 'base.user_system', {
  login: 'system',
  role: 'system',
  partner: ref('base.partner_system'),
});
```

Installer menyimpan pemetaan ID di tabel internal `_orm_data`. Perubahan email atau login tidak
membuat record baru, dan nilai yang sudah diedit tidak ditimpa. Pada pemasangan pertama, record lama
dapat diadopsi melalui field unik; referensi yang hilang atau konflik identitas membatalkan
transaksi.

### Upgrade versi

Installer mencatat versi addon di ledger `_orm_addons`. Perubahan data yang membutuhkan backfill
memakai hook programmatic di dalam transaksi installer:

```ts
defineAddon({
  name: 'sales',
  version: '1.1.0',
  models,
  upgrade: {
    '1.0.0': async (trx) => {
      await trx('sales_orders').whereNull('state').update({ state: 'draft' });
    },
  },
});
```

Hook menerima Knex transaction; tidak ada runner migrasi SQL. Versi turun ditolak dan schema sync
tidak melakukan perubahan destruktif otomatis.

## Model bisnis bawaan

`orm-base` menyiapkan data awal: **1 company** (`MoonWitness`), **2 user** (`system`, `superadmin`),
**10 partner**, dan **249 negara/area** berkode ISO 3166-1 alpha-2. Company default memakai United
States, USD, English (US), dan UTC. User dapat memilih bahasa dan zona waktu sendiri; nilai kosong
mengikuti pengaturan company dari profil partner, lalu fallback aplikasi `en-US` dan `UTC`.

Company dan Partner menyimpan alamat ringkas (`street`, `city`, `postal_code`, dan country). Nama,
email, dan telepon hanya disimpan di Partner. Profil dan company dimuat melalui
`GET /api/base.user?with=partner.company`.

### Partner, kategori, dan alamat

`base.partner_category` menyimpan kategori reusable seperti Customer dan Vendor;
`base.partner_category_link` menghubungkan banyak kategori ke satu partner. Alamat dipisah ke
`base.partner_address` dengan tipe contact/invoice/delivery/other, alamat jalan, kota,
state/province, kode pos, negara, dan penanda alamat utama. Field alamat lama pada `base.partner`
tetap tersedia agar record lama tidak rusak; record baru sebaiknya memakai model alamat
terstruktur. Seed contoh menghubungkan Acme Studio ke kategori Customer dan menyediakan alamat
Headquarters di San Francisco. Graph profile dapat dimuat dengan
`with=addresses.country,category_links.category`.

### Tag, attachment, dan activity

`base.tag` menyimpan label bersama dan `base.tag_link` menghubungkannya ke record dengan pasangan
`resource_model`/`resource_id`. API memeriksa bahwa model sudah terpasang dan record tujuan ada;
addon boleh memakai relasi yang sama tanpa mengubah skema addon base. Tag dapat dibaca semua user,
sedangkan perubahan memerlukan role administrator.

`base.attachment` menyimpan metadata file dan kunci objek penyimpanan saja; konten file tetap di
storage provider. `base.activity` menyediakan pengingat dengan jenis, tenggat, status, penanggung
jawab, dan target record. API memvalidasi target polimorfik dan mencegah target yang masih
direferensikan dihapus. Instalasi base menyertakan contoh metadata attachment; file tidak otomatis
dibuat di storage.

### Sequence

`base.sequence` menyimpan prefix, padding, dan penghitung berikutnya. Kode addon mengambil nomor
melalui helper transaksi agar pemanggilan bersamaan tidak menghasilkan nomor yang sama:

```ts
const reference = await nextSequence('sales.order'); // e.g. SO-0001
```

Seed base juga menyertakan tag Customer dan tautannya, aktivitas tindak lanjut, sequence
`sales.order`, membership superadmin, serta grant baca partner untuk grup `user`.

### Grup akses

`base.access_group` dan `base.group_membership` mengelompokkan user; pendaftaran otomatis memasukkan
user baru ke grup `user`. `base.model_access` memberi izin read/create/write/unlink per model kepada
grup. Role `system` dan `superadmin` mempertahankan hak admin; model akun, audit, dan pengaturan
akses tidak bisa dibuka melalui grant grup. Hak dibaca ulang dari database pada setiap request.

### Multi-company

`base.company_membership` adalah sumber izin company. Header `X-Company-Id` hanya diterima bila user
memiliki membership aktif; tanpa header, request memakai membership default. Record ber-company
dibatasi ke company terpilih untuk semua role. Record-rule addon ditambahkan sebagai syarat AND
sehingga tidak dapat menghapus batas tenant. Relasi ke record milik company lain dan perpindahan
record antar-company ditolak. Endpoint admin juga memeriksa role secara eksplisit.

### Audit dan outbox

Mutasi generic REST, action, dan JSON-RPC menjalankan perubahan record, audit log, dan event
`base.outbox_event` dalam satu transaksi database. Kegagalan salah satu langkah membatalkan semuanya.
Payload audit/outbox menyimpan snapshot terbatas dan menghapus nilai yang menyerupai password, token,
secret, credential, atau hash. Dispatcher outbox bersifat _at-least-once_; consumer harus memakai
`eventId` sebagai idempotency key untuk efek eksternal.

## API dan data

- REST generik di `/api/:model` dan JSON-RPC 2.0 di `/jsonrpc` memakai model, view, dan aturan akses
  yang sama.
- Collection mendukung keyset pagination `?cursor=0&limit=80`; lanjutkan dengan `nextCursor` dari
  response. Cursor memakai urutan `id asc`, tidak boleh digabung dengan offset, dan membatasi halaman
  hingga 500 record. Offset tetap tersedia untuk halaman kecil.
- Graph relasi dimuat dengan `with=`, misalnya `GET /api/base.user?with=partner.company`.
- Record nonaktif tidak tampil di pencarian standar dan dapat dipulihkan dengan `action_unarchive`.
  API menolak pengarsipan/penghapusan record referensi yang masih dipakai serta menolak user aktif
  dengan partner nonaktif.
- Perubahan melalui REST dan JSON-RPC ditulis ke `base.audit_log`, berisi actor, model, record,
  operasi, dan diff field. Log hanya bisa dibaca role `system`/`superadmin` dan tidak dapat
  diubah/dihapus lewat generic API.

Addon memasang indeks idempotent untuk `(active, id)`, `create_uid`, dan setiap foreign key.

## Autentikasi dan keamanan

`@moonwitness/auth` menyediakan login kredensial dan refresh token berotasi. Token rotasi berbagi
`family`; replay setelah lease kedaluwarsa mencabut seluruh family. Refresh token disimpan sebagai
fingerprint HMAC-SHA256, bukan plaintext, dan lease rotasi dibaca semua instance API dari database.
Default: access token 900 detik, refresh token 14 hari, dan rate limit login 10 percobaan.

### Password

`fields.password()` otomatis mengubah input menjadi hash scrypt dengan salt acak pada insert/update
ORM. Database hanya menyimpan hash pada kolom `users.password`; field ini tidak diserialisasikan ke
JSON dan tidak dapat dipilih melalui parameter `fields` API. `verifyPassword(input, user.password)`
tersedia untuk verifikasi. Jangan menulis password melalui query Knex mentah karena jalur itu
melewati hook hashing ORM.

Atur `SUPERADMIN_PASSWORD` di `.env` root sebelum menjalankan API. Saat startup, password diterapkan
pada akun dengan external ID `base.user_superadmin` hanya jika password-nya masih kosong, termasuk
untuk instalasi lama. Mengganti nilai `.env` setelah password terisi tidak mereset password akun.
Nilai kosong tidak mengaktifkan password; akun `system` tetap tanpa password awal.

### Peran dan akses

- `system` — akses administrasi penuh.
- `superadmin` — mengelola akun lain, tetapi tidak dapat membuat atau mengubah akun `system`.
- `user` — hanya membaca model bisnis dan tidak dapat membaca `base.user`.

Hak efektif adalah irisan role, membership company, dan grant `base.model_access`. Model akun, audit,
dan pengaturan akses tidak dapat dibuka melalui grant grup.

## Job queue, scheduler, dan outbox

`@moonwitness/jobs` menyediakan model `base.job`, `base.job_run`, `base.cron`, dan
`base.outbox_event`. Payload job divalidasi oleh handler bertipe saat enqueue dan sebelum dieksekusi.
Worker memakai lease, heartbeat, fencing token, retry dengan backoff, dead-letter, pembatalan
kooperatif, serta idempotency key. Handler tetap perlu idempotent karena proses dapat mati setelah
efek eksternal terjadi namun sebelum hasil tersimpan.

```sh
pnpm jobs:worker
pnpm jobs:scheduler
pnpm jobs:outbox
```

Scheduler mendukung timezone cron, misfire `skip`/`coalesce`/`catch_up`, dan concurrency
`allow`/`forbid`/`replace`. Worker production memuat handler domain dari `JOB_HANDLERS_MODULE`;
consumer outbox dimuat dari `OUTBOX_HANDLERS_MODULE`. Event tanpa consumer tetap pending.

Kontrol admin tersedia di `GET /admin/jobs/health`, `GET /admin/jobs`, `GET /admin/jobs/:id/runs`,
endpoint retry/cancel, `GET/POST/PATCH /admin/crons`, serta `GET /admin/outbox` dan retry dead
letter. Daftar tidak mengirim payload job/outbox, dan semua operasi kontrol dicatat ke audit log.

## Board admin

`apps/board` adalah aplikasi Next.js App Router yang menyajikan homepage publik dan Board dari
origin yang sama. Di development, Next.js meneruskan `/api`, `/auth`, `/jsonrpc`, `/health`,
`/livez`, `/readyz`, `/metrics`, `/notifications`, `/whatsapp`, dan `/workflows` ke
`BOARD_API_TARGET` (default `http://127.0.0.1:3000`).

| Route                                          | Fungsi                           |
| ---------------------------------------------- | -------------------------------- |
| `/`                                            | homepage publik, server-rendered |
| `/login`, `/register`                          | autentikasi                      |
| `/board`                                       | dashboard terproteksi            |
| `/board/profile`, `/board/settings`            | profil dan pengaturan            |
| `/board/knowledge`, `/board/stories/workbench` | knowledge dan story workbench    |
| `/board/m/:model`, `/board/m/:model/:id`       | daftar dan detail record         |
| `/board/whatsapp`                              | pairing dan inbox WhatsApp       |

URL lama (`/profile`, `/settings`, `/m/...`) diarahkan ke route `/board/...`. Board memakai
`@moonwitness/ui` untuk kontrol, token, dan pola komposisi; lihat [UI Bible](packages/ui/README.md)
dan [TOKENS.md](packages/ui/TOKENS.md).

Build production memakai `output: 'standalone'`. Set `NEXT_PUBLIC_SITE_URL` ke origin kanonik
sebelum build agar metadata, sitemap, dan robots benar. Halaman login dan area utama dipisah agar
bundle awal lebih kecil.

## WhatsApp gateway

Board memakai GoWA REST yang di-host; kredensial tetap di server dan browser tidak pernah menerima
Basic Auth. Route WhatsApp memakai company aktif dari sesi, sehingga client tidak dapat memilih
device GoWA atau JID company lain. `system` dan `superadmin` dapat pairing, disconnect, dan
mengirim; `user` membaca dalam company aktif dan membutuhkan grant `ModelAccess` eksplisit untuk
`whatsapp.account.write`, `whatsapp.conversation.create`, atau `whatsapp.message.create`.

Set `WHATSAPP_GATEWAY_URL`, `WHATSAPP_GATEWAY_USERNAME`, dan `WHATSAPP_GATEWAY_PASSWORD`. Untuk
receipt real-time, set `WHATSAPP_WEBHOOK_URL` ke origin HTTPS publik API dan
`WHATSAPP_WEBHOOK_SECRET` ke secret acak minimal 32 karakter. API memverifikasi
`X-Hub-Signature-256` terhadap raw body dan mencocokkan `session_id` dengan device yang dipetakan.
Tanpa webhook, Board memakai polling REST sebagai jalur refresh.

Panduan pairing, webhook, dan batasan volume ada di
[WhatsApp gateway](docs/operations/whatsapp.md).

## Perintah penting

| Kebutuhan                     | Perintah                                                          |
| ----------------------------- | ----------------------------------------------------------------- |
| API + Board + outbox          | `pnpm dev`                                                        |
| API saja / Board saja         | `pnpm dev:api` / `pnpm dev:board`                                 |
| Build seluruh workspace       | `pnpm build`                                                      |
| Unit test                     | `pnpm test`                                                       |
| Tes integrasi PostgreSQL      | `pnpm test:integration`                                           |
| End-to-end                    | `pnpm test:e2e`                                                   |
| Lint / cek format             | `pnpm lint` / `pnpm format:check`                                 |
| Typecheck                     | `pnpm typecheck`                                                  |
| Gerbang lengkap lokal         | `pnpm verify`                                                     |
| Worker, scheduler, outbox     | `pnpm jobs:worker` / `pnpm jobs:scheduler` / `pnpm jobs:outbox`   |
| Reset password superadmin     | `pnpm reset:superadmin-password`                                  |
| Cabut seluruh sesi auth       | `pnpm revoke:auth-sessions`                                       |
| Regenerate docs dan referensi | `pnpm docs:generate`                                              |
| Regenerate diagram arsitektur | `pnpm architecture:generate`                                      |
| Cek artefak generated         | `pnpm readme:check`, `pnpm docs:check`, `pnpm architecture:check` |

Daftar lengkap script root dan workspace ada di
[generated workspace reference](#generated-workspace-reference).

## Kualitas dan CI

CI pada `.github/workflows/ci.yml` berjalan untuk pull request ke `dev`/`main`, push ke `main`, dan
manual dispatch. Workflow menyediakan PostgreSQL 16 dan menjalankan lint, build, unit test, tes
integrasi, serta drill backup/restore pada database uji disposable.

Tes PostgreSQL lokal:

```bash
docker compose up -d postgres
docker compose exec -T postgres createdb -U postgres moonwitness_local_test
export POSTGRES_TEST_URL=postgresql://postgres:postgres@127.0.0.1:5432/moonwitness_local_test
pnpm test:integration
```

`pnpm test` menjalankan unit test dengan SQLite. Tanpa `POSTGRES_TEST_URL`, tes PostgreSQL dilewati.
Gunakan database kosong bernama `test`/`e2e`/`ci` dan jangan arahkan ke database berisi data penting.
Untuk memilih tes terkecil yang relevan, lihat
[panduan verifikasi lokal](docs/testing/FLAKY-TESTS.md#choose-the-smallest-useful-local-check).

### Artefak generated

Inventaris paket, routes, model, diagram arsitektur, dan blok workspace di README dihasilkan dari
metadata. Setelah mengubah model, dependency, atau script:

```bash
pnpm docs:generate
pnpm architecture:generate
pnpm readme:check
```

Commit source dan artefak generated dalam perubahan yang sama. `pnpm verify` menjalankan lint, format,
typecheck, unit test, architecture check, dan docs build.

## Deploy dan operasi

### Build dan jalankan

```bash
pnpm build
pnpm --filter @moonwitness/api start
pnpm --filter @moonwitness/board start
```

API membaca `DATABASE_URL`, `API_HOST`, `API_PORT`, `JWT_SECRET`, serta password bootstrap dari
environment. Production mewajibkan `DATABASE_URL` eksplisit (tanpa fallback database lokal) dan
`JWT_SECRET` persisten minimal 32 karakter; rotasi secret membatalkan semua access token yang
berlaku. Startup memvalidasi secret sebelum menyentuh database, lalu memastikan PostgreSQL, addon
base/auth, dan akun default siap. Logging production berupa JSON ke stdout; development memakai file
dan output pretty.

### Compose production

Salin `.env.production.example` ke `.env.production`, isi variabel bertanda wajib, lindungi file itu
di host, lalu:

```sh
docker compose --env-file .env.production -f docker-compose.production.yml up -d --build
docker compose --env-file .env.production -f docker-compose.production.yml ps
docker compose --env-file .env.production -f docker-compose.production.yml logs -f api jobs-worker jobs-scheduler outbox-worker
```

Compose menjalankan Board (Next.js standalone, port container 8080), API (3000), job worker,
scheduler, dan outbox worker. Database production tetap eksternal/terkelola. Semua port dipetakan ke
loopback; pasang reverse proxy HTTPS di depannya. Container berjalan sebagai user non-root, dengan
filesystem read-only dan tanpa Linux capabilities. Endpoint readiness tetap gagal sampai PostgreSQL
siap.

Tambahkan handler domain ke image dan isi `JOB_HANDLERS_MODULE`/`OUTBOX_HANDLERS_MODULE` dengan path
modul di dalam image.

### Health dan metrik

- `/livez` hanya memeriksa proses.
- `/readyz` menguji koneksi database dan cocok untuk readiness probe.
- `/health` tetap tersedia untuk kompatibilitas.
- `/metrics` mengaktifkan metrik Prometheus bila `METRICS_TOKEN` (acak, minimal 32 karakter) diisi;
  scrape dengan `Authorization: Bearer <METRICS_TOKEN>`. Metrik berisi request count/durasi per route
  template dan process uptime, tanpa label berisi ID pengguna.

### Backup dan restore

Jadwalkan `bash scripts/backup-postgres.sh` dengan `DATABASE_URL`, `BACKUP_DIR` di storage
terenkripsi/terpisah, dan `BACKUP_RETENTION_DAYS` (default 14). File custom-format memiliki izin
terbatas.

Pulihkan dengan `bash scripts/restore-postgres.sh` setelah mengatur `BACKUP_FILE`, `DATABASE_URL`,
dan `ALLOW_DATABASE_RESTORE=true`; skrip meminta operator mengetik nama database target sebelum
mengubahnya. `pnpm test:restore-drill` menjalankan drill ke dua database bernama acak dan membuktikan
mismatch confirmation ditolak tanpa mengubah sentinel target. Drill ini tidak menetapkan RPO/RTO
produksi: frekuensi backup off-host dan waktu provisioning/cutover harus ditetapkan serta diukur
operator. Simpan backup produksi di luar server/database utama dan gunakan enkripsi storage yang
dikelola infrastruktur.

### Deployment dan insiden

Deployment aplikasi dikelola operator di luar workflow GitHub repository ini. Sebelum mengganti
image: pastikan CI hijau (termasuk PostgreSQL, backup/restore, dan image build), backup database, dan
verifikasi provenance image. Setelah perubahan: periksa `/readyz`, `/livez`, login, alur mutasi,
job/outbox, dan log; catat image, commit, waktu, backup, serta hasil smoke test.

Saat insiden: kurangi traffic atau hentikan proses yang terdampak, simpan log dan metrik, periksa
readiness serta dead-letter job/outbox, dan jangan menghapus record antrean sebelum payload/penyebab
ditinjau. Jika credential bocor, rotasi secret di pengelola environment dan cabut sesi refresh;
rotasi `JWT_SECRET` juga membatalkan semua access token. Rollback image hanya aman bila schema/data
baru masih kompatibel, karena hook upgrade tidak dibalik otomatis. Pemulihan database adalah tindakan
terpisah dan destruktif: lakukan ke target terpilih dengan backup teruji, ikuti konfirmasi nama
database, lalu smoke test sebelum membuka traffic.

Panduan lanjutan: [attachment storage](docs/operations/attachment-storage.md),
[runtime operations](docs/engineering/runtime-operations.md),
[security incident response](docs/operations/security-incident-response.md), dan
[release artifact flow](docs/operations/release-artifact-flow.md).

## Dokumentasi

| Mulai di sini                                                                         | Isi                                                            |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| [Developer guide](docs/guide/index.md)                                                | Quickstart, how-to, reference, dan explanation.                |
| [Quickstart](docs/guide/tutorials/quickstart.md)                                      | Menjalankan PostgreSQL, API, dan Board.                        |
| [Arsitektur sistem](docs/guide/explanations/architecture.md)                          | Batas komponen dan alur request.                               |
| [Diagram arsitektur](docs/architecture/diagrams/README.md)                            | Dependency workspace, relasi model, auth, jobs, addon install. |
| [Panduan addon](docs/guide/how-to/addon-development.md)                               | Model, view, menu, seed, dependency, dan upgrade.              |
| [Kontrak API](docs/guide/reference/api.md)                                            | REST, JSON-RPC, filter, pagination, dan error.                 |
| [Model dan metadata](docs/guide/reference/models.md)                                  | Field, relasi, view, dan akses.                                |
| [Jobs dan outbox](docs/guide/how-to/jobs-outbox.md)                                   | Worker, scheduler, retry, dan dead letter.                     |
| [WhatsApp gateway](docs/operations/whatsapp.md)                                       | Pairing GoWA, webhook, dan inbox.                              |
| [Attachment storage](docs/operations/attachment-storage.md)                           | Storage lokal dan Garage S3.                                   |
| [Local AI](docs/guide/how-to/local-ai-hardware.md)                                    | Runtime loopback-only dan kebutuhan hardware.                  |
| [Kebijakan kompatibilitas](docs/engineering/compatibility.md)                         | Aturan perubahan kontrak dan addon.                            |
| [Feature coverage](docs/engineering/feature-coverage.md)                              | Bukti tes per fitur, role, dan company.                        |
| [Roadmap](ROADMAP.md) · [Changelog](CHANGELOG.md) · [Security](SECURITY.md)           | Rencana, riwayat rilis, dan kebijakan keamanan.                |
| [Brand assets](docs/design/brand-assets.md) · [UI catalog](docs/design/ui-catalog.md) | Sumber brand, token, dan katalog komponen.                     |

Referensi model, field, relasi, akses, environment, dan endpoint yang dihasilkan otomatis ada di
[generated platform reference](docs/guide/reference/generated-platform.md).

---

<!-- Blok di bawah dihasilkan dari docs/guide/reference/generated-platform.json. Jangan edit manual; jalankan `pnpm readme:generate`. -->

<!-- BEGIN GENERATED WORKSPACE REFERENCE -->

## Generated workspace reference

Monorepo version: `1.0.0-rc.1` · metadata fingerprint: `da8be776f3934efefa4a52d6b55262e249829b7fe90d250201757c071eaf7198`.

| App/package                     | Kind    | Version      | Workspace scripts                                                                                                                                                                                   |
| ------------------------------- | ------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@moonwitness/api`              | App     | `1.0.0-rc.1` | `attachments:reconcile`, `build`, `dev`, `jobs:outbox`, `jobs:scheduler`, `jobs:worker`, `reset:superadmin-password`, `revoke:auth-sessions`, `start`, `start:built`, `test`, `visual-audit:server` |
| `@moonwitness/board`            | App     | `1.0.0-rc.1` | `build`, `dev`, `lint`, `preview`, `start`, `start:built`, `typecheck`                                                                                                                              |
| `@moonwitness/docs`             | App     | `1.0.0-rc.1` | `dev`, `portal:build`, `portal:build:built`, `preview`, `test`, `typecheck`                                                                                                                         |
| `@moonwitness/ui-catalog`       | App     | `1.0.0-rc.1` | `build`, `build:built`, `dev`, `preview`, `test`                                                                                                                                                    |
| `@moonwitness/assets`           | Package | `1.0.0-rc.1` | `artwork:prepare`, `brand:prepare`, `fonts:prepare`                                                                                                                                                 |
| `@moonwitness/auth`             | Package | `1.0.0-rc.1` | `build`, `test`                                                                                                                                                                                     |
| `@moonwitness/client`           | Package | `1.0.0-rc.1` | `build`, `test`                                                                                                                                                                                     |
| `@moonwitness/corpus`           | Package | `1.0.0-rc.1` | `build`, `test`, `typecheck`                                                                                                                                                                        |
| `@moonwitness/eslint-config`    | Package | `1.0.0-rc.1` | —                                                                                                                                                                                                   |
| `@moonwitness/jobs`             | Package | `1.0.0-rc.1` | `build`, `test`                                                                                                                                                                                     |
| `@moonwitness/knowledge`        | Package | `1.0.0-rc.1` | `build`, `test`, `typecheck`                                                                                                                                                                        |
| `@moonwitness/local-ai`         | Package | `1.0.0-rc.1` | `build`, `test`, `typecheck`                                                                                                                                                                        |
| `@moonwitness/logger`           | Package | `1.0.0-rc.1` | `build`, `test`                                                                                                                                                                                     |
| `@moonwitness/orm`              | Package | `1.0.0-rc.1` | `build`, `test`                                                                                                                                                                                     |
| `@moonwitness/orm-base`         | Package | `1.0.0-rc.1` | `build`, `test`                                                                                                                                                                                     |
| `@moonwitness/orm-integration`  | Package | `1.0.0-rc.1` | `build`, `test`                                                                                                                                                                                     |
| `@moonwitness/orm-knowledge`    | Package | `1.0.0-rc.1` | `build`, `test`                                                                                                                                                                                     |
| `@moonwitness/orm-notification` | Package | `1.0.0-rc.1` | `build`, `test`                                                                                                                                                                                     |
| `@moonwitness/orm-organization` | Package | `1.0.0-rc.1` | `build`, `test`                                                                                                                                                                                     |
| `@moonwitness/orm-request`      | Package | `1.0.0-rc.1` | `build`, `test`                                                                                                                                                                                     |
| `@moonwitness/orm-storage`      | Package | `1.0.0-rc.1` | `build`, `test`                                                                                                                                                                                     |
| `@moonwitness/orm-workflow`     | Package | `1.0.0-rc.1` | `build`, `test`                                                                                                                                                                                     |
| `@moonwitness/research`         | Package | `1.0.0-rc.1` | `build`, `test`, `typecheck`                                                                                                                                                                        |
| `@moonwitness/types`            | Package | `1.0.0-rc.1` | `build`, `test`                                                                                                                                                                                     |
| `@moonwitness/ui`               | Package | `1.0.0-rc.1` | `build`, `test`                                                                                                                                                                                     |

Root commands: `pnpm architecture:check`, `pnpm architecture:check:built`, `pnpm architecture:generate`, `pnpm assets:check:bounds`, `pnpm assets:check:docs`, `pnpm assets:export:docs`, `pnpm assets:generate`, `pnpm assets:generate:illustrations`, `pnpm assets:render`, `pnpm assets:validate`, `pnpm attachments:reconcile`, `pnpm audit:workspace`, `pnpm automation:check:action-pins`, `pnpm automation:check:action-tags`, `pnpm automation:check:roadmap`, `pnpm automation:check:secrets`, `pnpm automation:check:ubuntu-runner-candidate`, `pnpm automation:check:workflow-trust`, `pnpm board:budget`, `pnpm board:ui:check`, `pnpm board:visual:update`, `pnpm build`, `pnpm ci:affected`, `pnpm dependency:candidate`, `pnpm dependency:plan`, `pnpm dev`, `pnpm dev:api`, `pnpm dev:board`, `pnpm docs:build`, `pnpm docs:build:built`, `pnpm docs:change:classify`, `pnpm docs:check`, `pnpm docs:check:built`, `pnpm docs:examples:check`, `pnpm docs:examples:check:built`, `pnpm docs:generate`, `pnpm docs:links`, `pnpm docs:links:external`, `pnpm docs:publication:check`, `pnpm format`, `pnpm format:check`, `pnpm hooks:install`, `pnpm jobs:outbox`, `pnpm jobs:scheduler`, `pnpm jobs:worker`, `pnpm lint`, `pnpm lint:fix`, `pnpm platform:audit`, `pnpm promotion:approval-check`, `pnpm promotion:risk`, `pnpm readme:check`, `pnpm readme:generate`, `pnpm release:changelog`, `pnpm release:check`, `pnpm release:classify`, `pnpm release:dry-run`, `pnpm release:plan`, `pnpm release:preflight:built`, `pnpm release:prepare`, `pnpm release:verify-attestations`, `pnpm reset:superadmin-password`, `pnpm revoke:auth-sessions`, `pnpm roadmap:issues:audit`, `pnpm roadmap:issues:plan`, `pnpm roadmap:progress`, `pnpm start`, `pnpm start:built`, `pnpm test`, `pnpm test:action-pins`, `pnpm test:action-tags`, `pnpm test:addon-conformance`, `pnpm test:affected`, `pnpm test:architecture`, `pnpm test:artifact-safety`, `pnpm test:assets`, `pnpm test:assets:source`, `pnpm test:board-budget`, `pnpm test:board-csv`, `pnpm test:ci-gate`, `pnpm test:coverage-policy`, `pnpm test:dependency-candidate`, `pnpm test:dependency-plan`, `pnpm test:docs-navigation`, `pnpm test:docs-portal`, `pnpm test:docs-publication`, `pnpm test:e2e`, `pnpm test:e2e:built`, `pnpm test:e2e:diagnostics`, `pnpm test:e2e:visual`, `pnpm test:e2e:visual:matrix`, `pnpm test:expected-ref`, `pnpm test:flaky-policy`, `pnpm test:integration`, `pnpm test:integration:built`, `pnpm test:knowledge-cli:built`, `pnpm test:maintenance-incidents`, `pnpm test:package-manager`, `pnpm test:platform-audit`, `pnpm test:promotion-policy`, `pnpm test:promotion-report`, `pnpm test:release-asset-reconcile`, `pnpm test:release-classification`, `pnpm test:release-dry-run`, `pnpm test:release-image-publish`, `pnpm test:release-latest-policy`, `pnpm test:release-orchestration`, `pnpm test:release-plan`, `pnpm test:release-prepare`, `pnpm test:release-prepare-workflow`, `pnpm test:release-verify-attestations`, `pnpm test:release-workflow`, `pnpm test:render-changelog`, `pnpm test:restore-drill`, `pnpm test:roadmap`, `pnpm test:secrets`, `pnpm test:security-policy`, `pnpm test:ubuntu-runner-candidate`, `pnpm test:ui`, `pnpm test:ui-budget`, `pnpm test:ui-catalog`, `pnpm test:unit`, `pnpm test:unit-runner-policy`, `pnpm test:unit:built`, `pnpm test:unit:ci`, `pnpm test:versioned-docs`, `pnpm test:whatsapp`, `pnpm test:workflow-trust`, `pnpm test:workspace-version-policy`, `pnpm typecheck`, `pnpm ui:budget`, `pnpm ui:visual:update`, `pnpm verify`.

Generated model, field, relation, access, environment-name, and endpoint references are in the [developer guide](docs/guide/index.md).

<!-- END GENERATED WORKSPACE REFERENCE -->
