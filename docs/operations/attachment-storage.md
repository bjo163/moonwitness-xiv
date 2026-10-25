# Menjalankan attachment storage dengan Garage / S3-compatible storage

## Kebijakan ukuran

- Berkas baru maksimal **10 MiB = 10.485.760 byte**.
- Aturan ini berlaku untuk unggahan lampiran record, media WhatsApp outbound, dan media historis WhatsApp yang diambil ulang dari gateway.
- Request WhatsApp memakai Base64. Karena itu API dan reverse proxy harus menerima body sampai **15 MiB**; server tetap menolak hasil decode di atas 10 MiB.
- Objek lokal yang sudah ada disalin dengan ukuran dan isi aslinya selama migrasi agar migrasi tidak merusak data legacy. Batas 10 MiB diberlakukan pada penerimaan media baru.

## Menyiapkan konfigurasi

Buat bucket privat dan access key khusus aplikasi dengan akses minimum hanya ke bucket tersebut. Jangan membuat bucket publik dan jangan menyimpan secret di repository. Provider menggunakan AWS S3 API dan dapat diarahkan ke layanan S3-compatible mana pun.

Untuk penyedia S3 yang mendukung IAM policy, batasi akses aplikasi ke pemeriksaan/list bucket serta get, head, put, dan delete object pada bucket terkait. Contoh di bawah ini adalah policy IAM S3 generik; Garage tidak memakai policy IAM ini untuk key S3 aplikasinya, jadi ikuti provisioning Garage di bawah.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": ["arn:aws:s3:::moonwitness-attachments"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": ["arn:aws:s3:::moonwitness-attachments/*"]
    }
  ]
}
```

Jangan berikan hak membuat/menghapus bucket ke service account aplikasi; buat bucket lewat proses provisioning operator. Pada Garage, `garage bucket allow --read --write` memberikan akses data ke key untuk bucket yang ditentukan tanpa memberikan hak owner.

Backend saat ini adalah Garage pada host terpisah, diakses lewat S3 API `https://s3.moonwitness.biz.id`. Buat key aplikasi dan bucket privat dari CLI Garage pada salah satu node klaster:

```bash
garage key create moonwitness-attachments
garage bucket create moonwitness-attachments
garage bucket allow --read --write moonwitness-attachments --key moonwitness-attachments
```

`garage bucket allow` tanpa `--owner` hanya memberi akses data, sehingga key aplikasi tidak dapat membuat bucket atau mengubah kebijakan. Jangan menaruh key administrator Garage (termasuk token admin API dan RPC secret) di environment API atau worker. Console web `https://s3-web.moonwitness.biz.id` dan admin API `https://s3-admin.moonwitness.biz.id` dipakai operator saat provisioning saja.

Garage S3 API sendiri tidak menyediakan TLS, sehingga endpoint publik `https://s3.moonwitness.biz.id` harus diakhiri oleh reverse proxy TLS di depan Garage. Pastikan proxy meneruskan request S3/SigV4 tanpa mengubah host, path, atau query string yang ditandatangani. API harus mempercayai rantai sertifikat endpoint; jangan mematikan verifikasi sertifikat sebagai jalan pintas. [Dokumentasi konfigurasi resmi Garage](https://garagehq.deuxfleurs.fr/documentation/reference-manual/configuration/) menjelaskan bahwa TLS untuk S3 API perlu disediakan oleh reverse proxy.

```dotenv
ATTACHMENT_STORAGE_DRIVER=s3
ATTACHMENT_S3_ENDPOINT=https://s3.moonwitness.biz.id
ATTACHMENT_S3_REGION=garage
ATTACHMENT_S3_BUCKET=moonwitness-attachments
ATTACHMENT_S3_ACCESS_KEY=<access key Garage dari secret manager>
ATTACHMENT_S3_SECRET_KEY=<secret key Garage dari secret manager>
ATTACHMENT_S3_FORCE_PATH_STYLE=true
```

`ATTACHMENT_S3_ENDPOINT` harus berupa URL HTTPS tanpa user/password di dalam URL. `ATTACHMENT_S3_REGION` harus sama dengan `[s3_api].s3_region` pada `garage.toml` — konfigurasi proyek menetapkan `garage`, bukan `us-east-1`, dan operator perlu mencocokkannya dengan cluster aktif. Bila salah, Garage menolak request SigV4 dengan `AuthorizationHeaderMalformed` yang menyebut region yang diharapkan. Path-style addressing aktif secara default dan didukung Garage. Aplikasi memeriksa akses bucket pada readiness probe.

Overlay `docker-compose.production.yml` mengaktifkan driver `s3` secara default untuk API serta semua worker, memakai endpoint Garage, memasang volume lokal legacy read-only, dan menolak startup jika kredensial aplikasi belum diisi. Overlay `docker-compose.development.yml` default ke driver `local` agar stack naik dengan satu perintah; isi `ATTACHMENT_STORAGE_DRIVER=s3` plus key Garage di `.env` untuk menguji bucket asli.

Simpan file deploy lokal sebagai `.env.production` (file tersebut diabaikan Git), isi variabel dari secret manager, lalu jalankan preflight sebelum Compose. Preflight gagal jika variabel wajib kosong, driver bukan `s3`, endpoint bukan HTTPS, endpoint memiliki credential inline, nama bucket tidak valid, atau access key mengandung spasi/garis miring. Diagnostik hanya menyebut nama variabel dan tidak mencetak nilainya:

```powershell
Copy-Item .env.production.example .env.production
pnpm attachments:production-preflight
docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.production.yml config --quiet
```

Setelah provisioning bucket, gunakan file env yang sama untuk deploy. Jangan menyimpan hasil `docker compose config` ke log CI karena konfigurasi hasil render memuat nilai environment.

Driver `s3` menggunakan layanan S3-compatible apa pun, termasuk Garage yang dipakai saat ini. Driver lokal hanya dipakai bila operator secara eksplisit mengatur `ATTACHMENT_STORAGE_DRIVER=local`, misalnya untuk rollback setelah reverse-sync objek baru.

### Keputusan data legacy

Pemilik memilih **bucket S3 hanya untuk unggahan baru dan tidak menyalin data legacy lokal**. Setelah driver global dialihkan ke `s3`, byte lampiran lama yang masih hanya berada di volume lokal tidak akan ditemukan lewat provider aktif. Baris metadata tetap berada di database, tetapi unduhan object legacy dapat berakhir 404. Tidak ada fallback otomatis ke disk lokal. Pertahankan volume lokal sebagai retensi/rollback; jangan hapus hingga masa retensi diputuskan.

### Reverse proxy

Atur batas body pada reverse proxy untuk route API menjadi sekurangnya 15 MiB. Contoh Nginx:

```nginx
location / {
    client_max_body_size 15m;
    proxy_read_timeout 120s;
    proxy_send_timeout 120s;
    proxy_pass http://moonwitness_api;
}
```

`15m` pada Nginx berarti 15 MiB. Terapkan batas yang sama pada load balancer/WAF lain di jalur request. Batas ini mengakomodasi JSON/Base64 WhatsApp; API tetap memeriksa hasil decode dan menolak file mentah di atas 10 MiB. Jangan menaikkan batas file mentah di aplikasi untuk menyelesaikan 413 dari proxy.

## Migrasi legacy (opsional, tidak dipilih untuk cutover ini)

Pemilik memutuskan legacy boleh ditinggalkan, sehingga **jangan jalankan migrator untuk cutover ini**. Jika keputusan berubah dan sebagian/seluruh legacy harus tetap tersedia, migrator berikut membaca referensi `attachments.storage_key` dan `whatsapp_messages.media_key`; jalankan dari runtime yang dapat mengakses volume lokal, PostgreSQL, dan bucket S3 tujuan. Dry-run adalah default dan sumber lokal tidak pernah dihapus.

```powershell
$env:ATTACHMENT_STORAGE_DRIVER = 's3'
pnpm attachments:migrate-to-s3
pnpm attachments:migrate-to-s3 -- --limit=1000 --offset=0
```

Dry-run memverifikasi sumber dan objek tujuan menggunakan byte serta SHA-256. Status `ready_to_copy` berarti objek belum ada di tujuan dan dapat disalin. Status `already_verified` berarti tujuan sudah cocok. `source_missing`, `source_mismatch`, `destination_conflict`, atau `failed` harus diselesaikan sebelum cutover.

Setelah meninjau dry-run, hentikan sementara unggah, hard-delete, dan pengambilan media WhatsApp atau gunakan maintenance mode yang memberi jaminan setara. Jalankan batch apply, lanjutkan dengan `--offset` yang dilaporkan sebagai `nextOffset`, dan ulangi sampai semua referensi selesai:

```powershell
pnpm attachments:migrate-to-s3 -- --apply --limit=1000 --offset=0
```

Perintah aman diulang: objek tujuan yang checksum-nya cocok dilaporkan `already_verified`; konten yang berbeda tidak ditimpa diam-diam. Simpan JSON output sebagai laporan cutover. Jika API berjalan dalam container, jalankan migrasi di container/job yang sama-sama memasang volume sumber lokal; path host yang tidak dipasang ke container tidak cukup.

Untuk keputusan saat ini, alihkan `ATTACHMENT_STORAGE_DRIVER=s3` di seluruh API dan worker saat maintenance singkat; tidak ada batch migrasi yang dijalankan. Sebelum cutover, provision bucket dan uji readiness. Pertahankan volume lokal dan backup DB. Jika rollback mengalihkan provider kembali ke lokal, objek yang dibuat di bucket S3 setelah cutover harus direverse-sync terlebih dahulu atau upload baru akan tidak tersedia.

Volume lokal pada overlay production sengaja read-only selama S3 aktif. Rollback yang benar-benar kembali ke driver `local` memerlukan reverse-sync dan perubahan eksplisit mount volume menjadi writable dalam maintenance window; jangan hanya mengubah variabel driver.

## Memeriksa konsistensi

Rekonsiliasi default bersifat read-only. Referensi kedua domain—lampiran umum dan pesan WhatsApp—dilindungi sebelum objek orphan dipertimbangkan.

```powershell
pnpm attachments:reconcile
pnpm attachments:reconcile -- --older-than=2026-10-01T00:00:00.000Z --limit=1000
```

Tinjau `missing`, `corrupt`, `unsupportedReferences`, `orphaned`, dan `scanTruncated`. `unsupportedReferences` mencatat key legacy/non-UUID yang sengaja tidak diperiksa pada object store aktif; cocokkan daftar itu dengan kebijakan retensi legacy. Jangan menjalankan penghapusan sampai semua pemilik key tercakup, grace period orphan disetujui, dan hasil dry-run diperiksa. `--apply` memerlukan cutoff eksplisit:

```powershell
pnpm attachments:reconcile -- --apply --older-than=2026-10-01T00:00:00.000Z --limit=1000
```

> Cutoff adalah batas umur objek untuk cleanup; pertimbangkan request unggah yang tertunda dan perubahan referensi database sebelum menggunakannya.

### Pembersihan orphan WhatsApp terjadwal

`jobs-scheduler` memastikan satu cron `whatsapp.attachments.reconcile` aktif setiap hari pukul 03:17 UTC. `jobs-worker` membuat snapshot referensi lampiran umum dan WhatsApp (pesan, Status, avatar, dan upload ticket yang masih dalam grace period), lalu hanya menghapus object UUID yang tak dirujuk dan lebih tua dari 24 jam. Setiap run dibatasi 1.000 orphan; bila pemindaian terpotong, run harian berikutnya melanjutkan. Snapshot dibatasi 100.000 key dan job gagal tertutup sebelum penghapusan jika ukuran snapshot melewati batas. Storage key tanpa format UUID tidak dihapus. Job hanya membersihkan object yatim; job ini tidak menghapus isi pesan, percakapan, record Status, audit, maupun mengatur retensi/kuota perusahaan.

Default kebijakan WhatsApp saat ini adalah menyimpan pesan dan Status tanpa batas serta tidak menerapkan kuota object per perusahaan. Tidak ada purge record terjadwal. Perubahan kebijakan retensi atau kuota harus mendapat keputusan produk terlebih dahulu dan memerlukan rencana ekspor/pemulihan sebelum purge diaktifkan.

Untuk cleanup manual, jalankan perintah `attachments:reconcile` dalam mode dry-run dan tinjau hasilnya seperti di atas. Cron terjadwal menjalankan scan-delete terpisah yang hanya memakai snapshot referensi, tanpa membaca seluruh byte object hidup untuk checksum. Status run dan ringkasan jumlah scan/orphan/delete tersedia pada riwayat job scheduler.

## Operasi dan pemulihan

- `/readyz` memeriksa koneksi PostgreSQL dan akses bucket S3.
- Bucket harus privat. API mengotorisasi record sebelum mengambil konten dan mengirim unduhan dengan cache privat.
- Driver local dan S3 mendukung `putStream`/`getStream`. Unduhan media GoWA dialirkan ke storage lalu ke respons Board tanpa membuat satu Buffer sebesar file. Driver local memakai file sementara dan rename atomik; S3 menggunakan multipart upload dengan satu part aktif. API tetap membatasi attachment 10 MiB dan menghitung SHA-256 saat ingest. Adapter storage lama yang hanya menyediakan `put`/`get` memakai jalur Buffer kompatibilitas.
- Simpan access key sebagai secret deployment dan rotasi dengan prosedur terencana.
- Pantau kegagalan/latensi storage, ukuran bucket, dan status rekonsiliasi. Error storage sementara mengembalikan 503; objek yang tidak ditemukan tetap 404.
- Cadangkan bucket dan database. Pemulihan yang konsisten memerlukan snapshot metadata serta objek yang saling cocok.
- Jadwalkan backup pada jendela maintenance atau gunakan snapshot konsisten: ekspor PostgreSQL (`pg_dump --format=custom`) dan salin bucket ke lokasi/bucket backup terpisah (`aws s3 sync` dengan endpoint S3 aktif). Simpan manifest waktu, ukuran, dan SHA-256 di luar bucket sumber.
- Lakukan restore drill ke database dan object store terisolasi. Pulihkan database dengan `pg_restore` ke database baru, pulihkan objek ke bucket uji, lalu jalankan `attachments:reconcile` dan cocokkan checksum sampel. Jangan menguji pemulihan dengan menimpa database/bucket aktif.
- Adapter acceptance menguji restore byte local dari salinan filesystem independen. Tes S3 opt-in juga menguji restore key acak pada bucket provider yang dikonfigurasi dan menghapus objek uji setelahnya. Kedua tes ini belum membuktikan satu snapshot database dan bucket dipulihkan bersama; itu tetap wajib dilakukan di lingkungan terisolasi sebelum cutover.
- Jangan hapus volume lokal sampai cutover diterima, backup tervalidasi, dan jendela rollback berakhir.

### Bukti penerimaan sebelum cutover

Simpan konfigurasi non-secret yang dipakai (endpoint tanpa credential, bucket, TLS, versi aplikasi, jumlah replica), snapshot DB/volume sumber, seluruh JSON migrasi, dan hasil perintah berikut sebagai bukti cutover:

1. Readiness setiap replica menunjukkan database dan storage siap.
2. Migrasi dry-run tidak memiliki `source_missing`, `source_mismatch`, `destination_conflict`, atau `failed`; apply berakhir dengan seluruh referensi `copied_verified` atau `already_verified`.
3. Rekonsiliasi sesudah copy tidak menunjukkan `missing`/`corrupt`; `scanTruncated` ditangani dengan batch lanjutan sampai cakupan lengkap.
4. Uji lewat Board/API: unggah, unduh, dan hapus satu lampiran record; kirim, baca, dan ambil media WhatsApp. Pastikan otorisasi lintas company tetap menolak akses.
5. Uji batas tepat 10 MiB dan penolakan 10 MiB + 1 byte. Uji JSON/Base64 melalui reverse proxy deployment, bukan hanya langsung ke API.
6. Pulihkan backup bucket dan database ke lingkungan terisolasi, lalu cocokkan sampel key/checksum sebelum menghapus volume lokal.

Jangan mencatat access key, secret key, token, isi file, atau URL bertanda tangan pada laporan tersebut. Jika layanan harus tetap online selama copy, hentikan cutover dengan prosedur maintenance ini dan desain dual-write/replay sebagai perubahan terpisah sebelum lanjut.

Pemeriksaan development terakhir pada provider S3-compatible dilakukan terhadap RustFS 1.0.3 lokal, sebelum Garage dipakai, dan berhasil untuk readiness serta put/get/list/delete melalui provider. Ini memverifikasi jalur S3-compatible dasar; pemeriksaan tersebut tidak menggantikan uji endpoint Garage yang aktif, sertifikat TLS, policy, proxy, atau bucket target.

Lihat [bukti penerimaan Compose development 2026-10-24](evidence/rustfs-compose-acceptance-2026-10-24.md) untuk hasil readiness, tes API/ORM live, rekonsiliasi lintas domain, volume yang dipertahankan, serta gerbang production yang belum dijalankan.
