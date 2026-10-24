# Quickstart lingkungan lokal

**Pembaca:** developer yang baru membuka repository. **Prasyarat:** Node.js 22, pnpm 11,
Docker Compose, dan akses ke repository. Semua perintah di halaman ini menargetkan database
development lokal; jangan arahkan ke database bersama atau production.

## 1. Siapkan environment dan PostgreSQL

Salin template environment, isi `SUPERADMIN_PASSWORD` untuk akun lokal, buat `JWT_SECRET` acak
minimal 32 karakter, lalu pastikan `DATABASE_URL` menunjuk PostgreSQL lokal dari Compose. Jangan
commit file `.env` atau menyalin nilai environment dari deployment.

```bash
cp .env.example .env
docker compose up -d postgres
pnpm install --frozen-lockfile
```

Di PowerShell, salin template dengan `Copy-Item .env.example .env`. Compose memakai port loopback
`127.0.0.1:5432`; tunggu sampai `docker compose ps` menampilkan service `postgres` berjalan sebelum
memulai API.

## 2. Build dan jalankan API serta Board

```bash
pnpm build
pnpm dev
```

`pnpm dev` menjalankan API dan Board bersama-sama. API membaca `.env`, memasang addon base/auth
secara programmatic, dan baru listen setelah koneksi database serta seed startup siap. Periksa
`http://localhost:3000/readyz`: hasil yang diharapkan adalah HTTP 200 dengan readiness bernilai
sehat. `/livez` hanya membuktikan proses hidup; gunakan `/readyz` untuk memeriksa database.

## 3. Buka Board atau jalankan aplikasi secara terpisah

Board tersedia di `http://localhost:5173` setelah `pnpm dev` siap. Jika hanya ingin menjalankan
salah satu proses, gunakan perintah ini dari root repository:

```bash
pnpm dev:api
pnpm dev:board
```

Board mem-proxy `/api`, `/auth`, `/jsonrpc`, dan `/health` ke API lokal. Login dengan `superadmin`
dan password development yang ditetapkan di `.env`. Seed contoh berisi company, user, partner, dan
data referensi; gunakan hanya untuk eksplorasi lokal.

## 4. Jalankan tes PostgreSQL terisolasi

Tes PostgreSQL membutuhkan database kosong dengan nama yang mengandung `test` atau `e2e`.
Buat database sementara dari service Compose dan arahkan `POSTGRES_TEST_URL` ke sana. Jangan gunakan
`moonwitness_db` atau database yang berisi data yang ingin disimpan.

```bash
docker compose exec -T postgres createdb -U postgres moonwitness_local_test
pg_user="$(docker compose exec -T postgres printenv POSTGRES_USER | tr -d '\r\n')"
pg_password="$(docker compose exec -T postgres printenv POSTGRES_PASSWORD | tr -d '\r\n')"
export POSTGRES_TEST_URL='postgresql://'
POSTGRES_TEST_URL+="${pg_user}:${pg_password}@127.0.0.1:5432/moonwitness_local_test"
pnpm test:integration
docker compose exec -T postgres dropdb -U postgres moonwitness_local_test
```

Di PowerShell, gunakan perintah berikut untuk menyiapkan environment tanpa menampilkan kredensial:

```powershell
$pgUser = (docker compose exec -T postgres printenv POSTGRES_USER).Trim()
$pgPassword = (docker compose exec -T postgres printenv POSTGRES_PASSWORD).Trim()
$env:POSTGRES_TEST_URL = 'postgresql://'
$env:POSTGRES_TEST_URL += "${pgUser}:${pgPassword}@127.0.0.1:5432/moonwitness_local_test"
pnpm test:integration
docker compose exec -T postgres dropdb -U postgres moonwitness_local_test
```

Jika tes gagal, tetap hapus database sementara setelah memeriksa bahwa namanya tepat `moonwitness_local_test`:
`docker compose exec -T postgres dropdb -U postgres moonwitness_local_test`. Jalankan tes secara serial
untuk database tersebut; setiap run E2E paralel perlu nama database disposable yang berbeda.

## 5. Verifikasi perubahan

```bash
pnpm verify
```

`pnpm verify` menjalankan lint, format, build/typecheck, unit test, architecture checks, serta
docs checks. `pnpm test:integration` membangun workspace, typecheck test integrasi, lalu menjalankan
test PostgreSQL dan performance pada schema acak di database yang ditunjuk `POSTGRES_TEST_URL`;
perintah tes tidak membuat atau menghapus database luarnya. Hasil yang diharapkan adalah command
berakhir dengan exit code 0. Jangan jalankan test pada database berisi data penting.

Untuk menghentikan service lokal, jalankan `docker compose down`. Tambahkan `-v` hanya bila memang
ingin menghapus volume database development dan seluruh seed/perubahan lokal.
