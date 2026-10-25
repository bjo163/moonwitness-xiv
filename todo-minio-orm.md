# Integrasi S3-Compatible (Garage Production, RustFS Development) dengan ORM dan Lampiran

## 1. Ringkasan hasil pemeriksaan proyek

- [x] Memeriksa workspace: monorepo TypeScript dengan `pnpm`.
- [x] Mengidentifikasi ORM: **Objection.js** untuk model, dengan **Knex 3** sebagai query builder dan migrasi.
- [x] Mengidentifikasi database aplikasi: PostgreSQL, dikonfigurasi melalui `DATABASE_URL`.
- [x] Menemukan paket inti ORM di `packages/orm` dan model dasar di `packages/orm-base`.
- [x] Menemukan abstraksi file di `packages/orm-storage`: `AttachmentStorage`.
- [x] Menemukan implementasi saat ini: `LocalFileAttachmentStorage`, menggunakan berkas lokal.
- [x] Menemukan tabel `attachments` yang menyimpan metadata dan `storage_key`; konten berkas tidak disimpan dalam baris database.
- [x] Menemukan alur unggah/unduh lampiran generik di `apps/api/src/routes/generic.routes.ts`.
- [x] Menemukan alur media WhatsApp yang juga menggunakan `AttachmentStorage` di `apps/api/src/routes/whatsapp.routes.ts`.
- [x] Menemukan injeksi provider di `apps/api/src/app.ts`, sehingga provider baru dapat dipasang tanpa mengubah model ORM inti.
- [x] Menemukan konfigurasi direktori lokal `ATTACHMENT_STORAGE_DIR` dan volume lampiran pada Compose development/production.
- [x] Menemukan perintah rekonsiliasi yang sekarang hanya mendukung penyimpanan lokal.
- [x] Kesimpulan: **object storage S3-compatible dapat diintegrasikan tanpa mengganti ORM atau database.** ORM tetap mengelola metadata dan relasi; development sebelumnya diuji dengan RustFS, sedangkan target production yang sekarang dikonfigurasi adalah Garage.

## 2. Sasaran dan batas integrasi

- [x] Simpan byte lampiran melalui provider S3-compatible; target bucket production sekarang Garage privat.
- [x] Simpan metadata, otorisasi, audit, dan relasi lampiran di PostgreSQL melalui model/ORM yang sudah ada.
- [x] Pertahankan satu antarmuka `AttachmentStorage` agar route tidak bergantung langsung pada SDK S3.
- [x] Integrasi provider abstrak `local|s3` selesai. Perubahan Compose terbaru memakai provider lokal secara default di development dan Garage S3 eksternal di production; RustFS hanya target uji historis.
- [x] Sediakan migrator dry-run/apply opsional untuk deployment yang ingin mempertahankan legacy; pemilik memilih tidak menjalankan migrasi.
- [x] Hindari menyimpan kredensial object storage atau URL bertanda tangan ke dalam metadata publik model.
- [x] Validasi konfigurasi S3-compatible saat startup; tidak ada fallback diam-diam ke disk lokal.
- [x] Catat keputusan pemilik: **unggahan baru masuk object storage S3-compatible aktif (Garage production); berkas legacy di disk lokal boleh tidak tersedia setelah cutover**.
- [x] Standar ukuran produk: **maksimum 10 MiB (10.485.760 byte) per berkas untuk semua jalur yang menyimpan berkas**, termasuk lampiran record, media outbound WhatsApp, dan media historis WhatsApp yang diambil dari gateway.
- [x] Untuk request WhatsApp berbasis JSON/Base64, batas payload transport: **15 MiB** pada API dan reverse proxy; setelah decode, batas berkas tetap 10 MiB.

## 3. Keputusan desain yang perlu ditetapkan

- [x] Tetapkan pemilih backend `ATTACHMENT_STORAGE_DRIVER=local|s3`.
- [x] Tetapkan variabel generik S3 `ATTACHMENT_S3_ENDPOINT`, `ATTACHMENT_S3_REGION`, `ATTACHMENT_S3_BUCKET`, `ATTACHMENT_S3_ACCESS_KEY`, `ATTACHMENT_S3_SECRET_KEY`, dan `ATTACHMENT_S3_FORCE_PATH_STYLE`.
- [x] Konfigurasikan endpoint sebagai URL HTTP(S) lengkap dan validasi saat startup; URL tidak boleh menyertakan kredensial.
- [x] Wajibkan bucket privat diprovision operator; aplikasi tidak membuat bucket otomatis.
- [x] Sediakan default S3 generik `us-east-1` dengan opsi override; production Garage menetapkan `garage` dan berhasil diuji terhadap endpoint aktif.
- [x] Gunakan satu konstanta kebijakan server 10 MiB = 10 × 1.024 × 1.024 = 10.485.760 byte untuk ukuran berkas mentah; jangan membuat limit berbeda per provider.
- [x] Tetapkan body limit request WhatsApp/Base64 minimal 15 MiB end-to-end di Fastify dan reverse proxy; validasi hasil decode tetap maksimum 10 MiB.
- [x] Batasi media WhatsApp yang diambil dari gateway ke 10 MiB sebelum `put`; jika lebih besar, tolak tanpa menyimpan objek parsial.
- [x] Pusatkan nilai limit 10 MiB di `@moonwitness/types`; UI dan API memakai konstanta yang sama, server tetap otoritas akhir.
- [x] Pertahankan key UUID lama agar skema dan perilaku lama tetap kompatibel.
- [x] Pertahankan unggah/unduh melalui API untuk mempertahankan pemeriksaan otorisasi; presigned URL tidak dipakai.
- [x] Tangani kegagalan lintas PostgreSQL/object store dengan kompensasi, error 503 yang aman, logging, dan rekonsiliasi orphan.
- [x] Gunakan retry SDK maksimum 3 kali, timeout koneksi 3 detik, socket 15 detik, dan path-style addressing default.

## 4. Rencana implementasi rinci

### A. Kontrak provider dan metadata

- [x] Pastikan kontrak `AttachmentStorage` mencakup `put`, `get`, `delete`, dan `list`.
- [x] Gunakan UUID acak sebagai key; migrator memeriksa tujuan lebih dahulu, menolak konflik isi, dan aman diulang untuk konten identik.
- [x] `get` memetakan key hilang menjadi `null`; kegagalan koneksi/credential/bucket diteruskan sebagai error.
- [x] `delete` S3 idempoten.
- [x] Hitung SHA-256 dari byte di aplikasi dan simpan sebagai metadata S3; listing tidak memakai ETag sebagai checksum.
- [x] Verifikasi checksum referensi dengan membaca objek; daftar objek remote hanya mengambil key, ukuran, dan waktu modifikasi.
- [x] Validasi UUID sebelum setiap operasi storage.
- [x] Pertahankan kontrak buffer untuk limit berkas baru 10 MiB; streaming ditunda dan keputusan dicatat karena bukan kebutuhan cutover ini.

### B. Implementasi provider RustFS/S3

- [x] Pilih AWS SDK S3 JavaScript untuk API S3-compatible RustFS.
- [x] Tambahkan SDK dan handler HTTP ke `packages/orm-storage`, terpisah dari ORM/model.
- [x] Implementasikan `S3AttachmentStorage` di paket storage.
- [x] Injeksi endpoint, region, kredensial, bucket, timeout, retry, dan opsi addressing lewat konstruktor; kelas provider tidak membaca environment langsung.
- [x] Konfigurasikan endpoint/path-style sesuai konfigurasi RustFS.
- [x] Simpan checksum SHA-256 sebagai metadata object; API memakai mimetype dari metadata ORM saat unduh.
- [x] Validasi UUID pada key.
- [x] Pertahankan operasi buffer dengan limit 10 MiB untuk write provider normal; migrator dapat mempertahankan berkas lama yang lebih besar.
- [x] Petakan objek hilang ke `null`; teruskan kegagalan bucket, autentikasi, konektivitas, dan server.
- [x] Implementasikan delete idempoten.
- [x] Implementasikan listing `ListObjectsV2` dengan pagination.
- [x] Abaikan key yang tidak mengikuti format UUID.
- [x] Listing S3 memakai ukuran dan waktu modifikasi; checksum dihitung dengan membaca objek referensi dan tidak memakai ETag.
- [x] Bucket tidak publik; unduhan tetap melalui API dengan otorisasi dan header privat.
- [x] Ekspor provider dan tipenya dari paket storage.

### C. Pemilihan backend dan konfigurasi startup

- [x] Tambahkan tipe konfigurasi storage di `packages/types`.
- [x] Parsing dan validasi konfigurasi S3-compatible di API.
- [x] Tolak driver tak dikenal dengan pesan konfigurasi yang jelas.
- [x] Validasi endpoint, bucket, dan kredensial saat driver S3 aktif.
- [x] Jangan mengeluarkan secret dalam error/readiness/log konfigurasi.
- [x] Buat factory storage tunggal.
- [x] Bagikan instance factory yang sama kepada rute generik dan WhatsApp.
- [x] Pertahankan injection option `attachmentStorage` untuk tes/pemanggil khusus.
- [x] Gunakan `ATTACHMENT_STORAGE_DIR` untuk driver lokal; nilai lama tetap memiliki default.
- [x] Tambahkan contoh env tanpa kredensial nyata.
- [x] Selaraskan contoh environment production dan dokumentasi operasional.
- [x] Compose meneruskan konfigurasi storage ke API dan seluruh worker melalui anchor environment.

### D. Integrasi dengan model, transaksi, dan API

- [x] Model `base.attachment` tetap mengelola metadata/otorisasi; RustFS hanya menyimpan byte.
- [x] Tidak ada byte file, secret storage, atau URL presigned pada kolom/record model.
- [x] Pertahankan urutan upload lalu transaksi metadata yang ada dan tangani kegagalan tiap batas.
- [x] Jika pembuatan metadata gagal, kompensasikan dengan delete; log kegagalan kompensasi.
- [x] Objek orphan dari kompensasi yang gagal ditemukan cleanup lintas-domain setelah grace period.
- [x] Hard-delete metadata tetap sukses bila penghapusan object gagal; kegagalan dicatat dan orphan dapat direkonsiliasi.
- [x] Unduhan tetap memeriksa akses record lampiran serta resource induk sebelum membaca object.
- [x] UX storage 503, retensi file untuk retry, tombol retry unduh, dan retry preview WhatsApp dicatat/diterapkan pada bagian O di [todo-ui.md](todo-ui.md).
- [x] Respons unduhan mempertahankan `Content-Type`, nama file aman, `nosniff`, dan `private, no-store`.
- [x] Semua endpoint unggah menerapkan limit 10 MiB dan menolak body kosong.
- [x] Alur media WhatsApp menggunakan provider yang sama; fetch gateway dibatasi secara streaming ke 10 MiB.
- [x] Client dan Board tetap menggunakan endpoint API; kontrak tidak mengekspos endpoint RustFS.
- [x] URL bucket dan URL presigned tidak dikirim ke klien.

### E. Operasional, Docker, dan secret

- [x] Penerimaan Compose development historis memakai service RustFS internal `http://storage:9000` dan bucket privat; Compose development terkini default ke provider lokal dan dapat diarahkan ke Garage via environment.
- [x] Bukti Compose development historis menggunakan RustFS internal. Overlay production terbaru mengarahkan API/worker ke Garage eksternal HTTPS; object store tidak dijalankan dalam Compose production.
- [x] Teruskan env ke jobs worker, scheduler, dan outbox worker.
- [x] Pertahankan volume lokal sebagai retensi/rollback; volume tidak dihapus dan bukan lagi default provider production.
- [x] Compose development tetap dapat dipilih ke provider lokal dengan `ATTACHMENT_STORAGE_DRIVER=local`.
- [x] `deploy/nginx-board.conf` dihapus 25 Oktober 2026: Board production berjalan sebagai Next.js standalone (stage `board-runtime` di `Dockerfile`), tidak ada Dockerfile/Compose/dokumen/test yang mereferensikan template itu lagi, dan daftar path-nya tidak memuat `/whatsapp` sehingga berisiko menyesatkan operator yang sedang merutekan origin publik. Daftar path yang benar kini tercatat di `docs/operations/whatsapp.md` bagian **Publishing the API origin**.
- [x] Gunakan service RustFS Compose historis untuk bukti kompatibilitas provider; deployment development terkini tidak lagi memulai service tersebut.
- [x] Konfigurasi production Garage memakai endpoint S3 HTTPS publik; aplikasi tidak memakai admin API atau console.
- [x] Volume lampiran lokal lama dipertahankan read-only pada overlay production saat driver S3 aktif; prosedur rollback meminta remount writable secara eksplisit setelah reverse-sync.
- [x] Tambahkan preflight production yang menolak endpoint non-HTTPS, URL berisi credential, driver local, bucket invalid, access key salah format, atau env wajib kosong; error tidak mencetak secret.
- [x] Dokumentasikan provisioning bucket privat dan policy minimum di `docs/operations/attachment-storage.md`.
- [x] Dokumentasikan penggunaan secret deployment; tidak ada secret yang ditambahkan ke repository.
- [x] Tetapkan aturan TLS production: Garage berada di luar jaringan Compose, memakai endpoint HTTPS dan sertifikat yang dipercaya API; preflight mewajibkan HTTPS untuk semua endpoint.
- [x] Dokumentasikan backup, pemulihan, retensi, pemantauan, dan rollback.
- [x] Readiness probe memeriksa PostgreSQL dan akses bucket tanpa membocorkan credential.

### F. Migrasi data dari provider lokal

- [x] Perintah migrasi menginventarisasi key lampiran dan WhatsApp dari DB, lalu menghitung ukuran byte saat membaca sumber lokal.
- [x] Buat `attachments:migrate-to-s3` yang menyalin key lama tanpa mengubah metadata. Perintah ini sekarang terhubung sebagai `pnpm attachments:migrate-to-s3` (root) dan `pnpm --filter @moonwitness/api attachments:migrate-to-s3`; sebelum 25 Oktober 2026 file perintahnya ada tetapi belum terdaftar di `package.json`, sehingga langkah di `docs/operations/attachment-storage.md` tidak dapat dijalankan operator. Verifikasi: build API lulus, argumen invalid keluar dengan kode 1, dan `--limit=1` lolos validasi lalu berhenti pada koneksi PostgreSQL lokal yang memang tidak berjalan pada sesi ini.
- [x] Verifikasi ukuran dan SHA-256 terhadap checksum metadata dan hasil object tujuan.
- [x] Dry-run default melaporkan `ready_to_copy`, `already_verified`, `source_missing`, `source_mismatch`, `destination_conflict`, dan `failed`.
- [x] Mode apply idempoten dan dapat dilanjutkan memakai pasangan `--limit`/`--offset`.
- [x] Jalankan salinan satu per satu; SDK retry transient 3 kali dan tiap kegagalan dilaporkan tanpa detail secret.
- [x] Migrasi tidak pernah menghapus objek sumber lokal.
- [x] JSON stdout menjadi laporan audit yang dapat disimpan operator.
- [x] Dokumentasikan maintenance/read-only saat sinkronisasi final dan alih trafik terkoordinasi.
- [x] Pemilik memilih tanpa migrasi legacy; tidak menjalankan inventaris/copy. Jalur API/ORM/WhatsApp telah diuji live terhadap Garage dengan database tes; lihat [bukti Garage](docs/operations/evidence/garage-live-acceptance-2026-10-24.md).
- [x] Dokumentasikan masa retensi volume sumber sebelum penghapusan.
- [x] Dokumentasikan rollback dan reverse-sync untuk upload/delete pasca-cutover.

### G. Rekonsiliasi dan pembersihan objek

- [x] Perintah `attachments:reconcile` memilih provider dari konfigurasi dan memakai rekonsiliasi provider-neutral.
- [x] Rekonsiliasi remote tidak memakai scan lokal; provider mencantumkan objek dengan listing S3 paginated.
- [x] Key referensi legacy yang bukan UUID dilaporkan pada `unsupportedReferences`; tidak dihitung sebagai missing RustFS dan tidak menggagalkan scan.
- [x] Pisahkan cek referensi DB (missing/corrupt) dari scan objek (orphan).
- [x] Listing RustFS memakai `ListObjectsV2` dan continuation token.
- [x] Dry-run menjadi default.
- [x] Penghapusan wajib memakai `--apply` dan cutoff `--older-than` eksplisit.
- [x] Orphan yang lebih baru dari cutoff dilindungi; default dry-run meninjau object yang lebih tua dari grace period 24 jam.
- [x] Batasi snapshot referensi dan jumlah orphan per batch.
- [x] Laporan per key tidak memuat secret atau konten.
- [x] Dokumentasikan review laporan sebelum `--apply` pada deployment.

### H. Keamanan dan privasi

- [x] Gunakan bucket privat dan credential server-side; browser tidak menerima access key RustFS.
- [x] Batasi object key ke UUID, tidak memakai nama file kiriman pengguna.
- [x] Pertahankan nama file aman/encoded pada header unduhan.
- [x] Pertahankan pemeriksaan role/group dan akses resource sebelum operasi unduh/hapus.
- [x] Sanitasi pesan storage dan dokumentasikan larangan logging credential, presigned URL, konten, dan token.
- [x] Atur timeout koneksi/socket dan perilaku 503 agar API tidak menggantung saat storage tidak tersedia.
- [x] Pertahankan daftar MIME allowlist generik; scanning malware dicatat sebagai kebijakan deployment terpisah.
- [x] Dokumentasikan retensi/penghapusan objek dan backup.
- [x] Validasi konfigurasi production Compose dengan placeholder pernah lulus untuk rancangan RustFS internal; rancangan itu sudah digantikan Garage eksternal HTTPS. Validasi Compose bukan bukti runtime production.

### I. Pengujian dan kriteria penerimaan

- [x] Tes unit provider mencakup upload dan metadata ukuran/checksum.
- [x] Tes membaca object dan pemetaan key hilang menjadi `null`; bucket hilang diteruskan sebagai error.
- [x] Tes validasi key, penghapusan, batas 10 MiB, dan endpoint.
- [x] Tes pagination listing melewati batas satu halaman dan ETag tidak diperlakukan sebagai SHA-256.
- [x] Tes konfigurasi provider menolak endpoint invalid/credential inline/bucket kosong; konfigurasi environment tercakup build.
- [x] Factory lokal/RustFS-S3 dan injection dipakai API; build memvalidasi integrasi statis.
- [x] Tes rute API memverifikasi auth dan akses resource; tes WhatsApp memverifikasi storage failure serta limit 10 MiB.
- [x] Tes rollback upload generik dan kompensasi objek yang telanjur disimpan tersedia pada tes ORM API.
- [x] Tes alur WhatsApp dengan provider palsu yang mengikuti kontrak.
- [x] Tes rekonsiliasi dry-run lokal melindungi key WhatsApp dan apply menghapus hanya orphan stale.
- [x] Smoke test provider live lokal pada RustFS 1.0.3 berhasil: readiness, put, get, list, delete, dan verifikasi objek hilang; bucket/key uji dibuat unik dan dibersihkan.
- [x] Penerimaan Compose historis dan live Garage: readiness, API/ORM, unggah-baca-hapus attachment, penyimpanan/baca media WhatsApp, dan cleanup object uji berhasil; hasil rinci dipisahkan di [bukti RustFS historis](docs/operations/evidence/rustfs-compose-acceptance-2026-10-24.md) dan [bukti Garage live](docs/operations/evidence/garage-live-acceptance-2026-10-24.md).
- [x] Tes penerimaan opsional dengan RustFS live melewati endpoint API/ORM: unggah-unduh-hapus lampiran dan simpan-baca media WhatsApp berhasil; objek uji dibersihkan. Perintah: aktifkan `ATTACHMENT_S3_ACCEPTANCE=1` dan set `ATTACHMENT_S3_*`, lalu jalankan tes `orm.test.ts` dan `whatsapp.routes.test.ts`.
- [x] Catat versi, service, volume, konfigurasi non-secret, hasil tes, readiness, rekonsiliasi, dan gerbang terbuka pada [bukti penerimaan Compose 2026-10-24](docs/operations/evidence/rustfs-compose-acceptance-2026-10-24.md).
- [x] Preflight menerima konfigurasi Garage HTTPS dan menolak konfigurasi tidak aman; 6 uji kebijakan/validasi lulus, tanpa mencetak nilai secret.
- [x] Restore drill historis development lulus: database sementara mempertahankan jumlah referensi; `pnpm test:restore-drill` memulihkan fixture aplikasi terisolasi, menolak target salah, dan memverifikasi relasi/login; objek RustFS development dipulihkan dari bucket backup sementara dan byte cocok. Ini bukan backup/restore Garage production; restore disaster-domain production tetap terbuka.
- [x] Uji endpoint Garage HTTPS dengan key dan bucket dari `.env`: TLS, readiness, SigV4, region `garage`, path-style, put/get/list/delete, dan API acceptance berhasil. Ini belum berarti API production telah di-rollout.
- [x] Build `@moonwitness/orm-storage` dan `@moonwitness/api` berhasil; suite API penuh 268 lulus/24 dilewati dan suite storage 14 lulus/1 dilewati. Acceptance live Garage terpisah lulus; detail ada di [bukti Garage](docs/operations/evidence/garage-live-acceptance-2026-10-24.md).
- [x] Compose development mempertahankan pilihan provider lokal/S3; overlay production menunjuk Garage melalui HTTPS dan memakai key yang diberi akses bucket tertentu.
- [ ] Penerimaan cutover Garage pada runtime API production, proxy API, database production, backup offsite dan restore production belum dilakukan; bukti live Garage menggunakan runtime tes lokal.

## 5. Urutan pengerjaan yang disarankan

- [x] Tahap 1 — Sepakati kontrak konfigurasi, bucket, perilaku default, limit 10 MiB, dan jalur migrasi.
- [x] Tahap 2 — Implementasikan provider S3-compatible untuk RustFS di `packages/orm-storage` dan uji kontrak provider.
- [x] Tahap 3 — Tambahkan parsing konfigurasi dan factory provider pada aplikasi API.
- [x] Tahap 4 — Pastikan rute generic dan WhatsApp memakai provider hasil factory yang sama.
- [x] Tahap 5 — Tambahkan konfigurasi Compose dan dokumentasi secret/bucket.
- [x] Tahap 6 — Sediakan migrator opsional lokal-ke-RustFS; keputusan deployment saat ini tidak memigrasikan legacy.
- [x] Tahap 7 — Perluas rekonsiliasi dan prosedur cleanup orphan untuk S3-compatible storage.
- [x] Tahap 8 — Verifikasi alur unggah/unduh/penghapusan dan uji kegagalan integrasi.
- [ ] Tahap 9 — API/ORM sudah diverifikasi live ke Garage; rollout aplikasi ke runtime production, proxy API, backup offsite, dan verifikasi production tetap diperlukan. Legacy copy tidak dilakukan.
- [ ] Tahap 10 — Pantau error dan kapasitas; pertahankan volume legacy lokal sampai retensi/rollback diputuskan.

## 6. Berkas dan area kode yang kemungkinan berubah

- [x] `packages/orm-storage/src/index.ts` dan `s3.ts` — kontrak provider lokal dan RustFS/S3.
- [x] `packages/orm-storage/package.json` dan lockfile — dependensi SDK S3.
- [x] `packages/types/src/config.ts` dan `attachments.ts` — konfigurasi storage dan standar limit bersama.
- [x] `apps/api/src/config/env.ts` — parsing dan validasi env storage.
- [x] `apps/api/src/app.ts` dan `apps/api/src/storage/` — konstruksi/injeksi provider tunggal.
- [x] `apps/api/src/commands/attachments-reconcile.ts` — provider pilihan dan scan remote.
- [x] `apps/api/src/commands/attachments-migrate-to-s3.ts` — migrator opsional lokal ke RustFS/S3.
- [x] `.env.example` dan `.env.production.example` — contoh konfigurasi tanpa secret.
- [x] Compose development/production — penerusan konfigurasi; volume lokal tetap untuk rollback.
- [x] Tes provider storage dan tes API ORM/WhatsApp untuk kontrak, batas, serta kegagalan.
- [x] `docs/operations/attachment-storage.md` — bucket, policy, backup, cutover, dan rollback.
- [x] `scripts/verify-attachment-storage-production-env.mjs` — preflight deployment yang memeriksa HTTPS dan konfigurasi S3-compatible Garage tanpa mencetak secret.

## 7. Risiko dan mitigasi

- [x] **Object store dan transaksi SQL tidak atomik.** Kompensasi, idempotensi, log kegagalan, grace-period orphan, dan reconcile sudah diterapkan; worker retry khusus/outbox ditunda karena dapat dipulihkan lewat rekonsiliasi operasional.
- [x] **ETag bukan jaminan SHA-256.** Migrator menghitung SHA-256 eksplisit dan provider menulis checksum metadata; ETag tidak dipakai sebagai checksum.
- [x] **Pergantian provider membuat objek legacy lokal tidak tersedia.** Ini sesuai keputusan pemilik: tidak memigrasikan data lama; volume lokal tetap disimpan untuk retensi/rollback.
- [x] **Rekonsiliasi remote dapat memindai volume besar.** Pagination, batas, grace period, dry-run default, dan apply eksplisit tersedia.
- [x] **Konfigurasi endpoint/proxy dapat memengaruhi signature S3.** Request live Garage dengan TLS/SigV4 berhasil untuk readiness, put/get/list/delete.
- [ ] **Batas reverse proxy API berbeda dari S3 proxy.** Uji request WhatsApp Base64 sampai 15 MiB melalui reverse proxy API production masih diperlukan.
- [x] **Kredensial terlalu luas dapat membuka bucket lain.** Dokumentasi memberi contoh policy minimal; credential dikelola operator dan tidak masuk repo.
- [x] **Penghapusan objek gagal setelah metadata dihapus.** Kegagalan dilog; objek menjadi orphan yang dapat ditemukan dan dibersihkan aman setelah grace period.
- [x] **Penggunaan buffer membatasi throughput berkas besar.** Batas produk 10 MiB diberlakukan; streaming ditunda sampai kebutuhan ukuran lebih besar terbukti.

## 8. Keputusan operasional dan konfigurasi

- [x] Bukti historis development: service `storage` memakai image `rustfs/rustfs:1.0.3`; API memakai `http://storage:9000` pada Compose dan tes live provider/API/ORM berhasil.
- [x] Bukti historis development: bucket `moonwitness-attachments` tersedia di RustFS lokal; host development mengakses `http://127.0.0.1:9000` pada loopback.
- [x] Pemilik memutuskan unggahan baru memakai object storage S3-compatible; data lokal lama boleh ditinggalkan/tidak tersedia dan tidak dimigrasikan.
- [x] Konfigurasi production terbaru menunjuk Garage eksternal `https://s3.moonwitness.biz.id`, region `garage`, path-style, dan TLS wajib. Ini menggantikan asumsi endpoint RustFS internal production.
- [x] Verifikasi bucket/key Garage dari `.env` melalui readiness dan operasi S3/API live; nilai credential tidak dimasukkan ke bukti.
- [x] Verifikasi region `garage`, path-style, TLS dan request SigV4 lewat endpoint Garage aktif dari hasil operasi live.
- [ ] Pastikan semua proxy/deployment di depan API menerima request WhatsApp Base64 sampai 15 MiB, sambil tetap membatasi berkas mentah 10 MiB.
- [x] Compose development menjalankan satu replica API; production wajib memakai endpoint/bucket sama pada semua replica.
- [ ] Cutover production ke Garage dilakukan saat maintenance singkat; dual-write/replay tidak dibutuhkan tanpa migrasi legacy, tetapi perubahan driver/runtime belum diterapkan.
- [x] Provider lokal dipertahankan untuk development dan retensi/rollback legacy.
- [x] Target eksternal Garage sudah dipilih; endpoint, bucket, region, TLS, dan provisioning key didokumentasikan dan endpoint/key berhasil diuji. Rollout aplikasi API production masih terbuka.

## 9. Temuan arsitektur mendalam yang wajib memengaruhi desain

### A. Provider storage melayani dua domain data

- [x] Perlakukan `AttachmentStorage` sebagai storage bersama untuk **lampiran umum dan media WhatsApp**, bukan hanya model `base.attachment`.
- [x] Petakan seluruh pemilik object key: `base.attachment.storage_key` dan `WhatsappMessage.media_key`.
- [x] Perbaiki cakupan rekonsiliasi agar kedua tabel melindungi objek ketika listing provider memindai semua key.
- [x] Tambahkan tes regresi: media WhatsApp tanpa baris `attachments` tetap terlindungi dari orphan cleanup.
- [x] Buat rekonsiliasi dengan snapshot key referensi lintas domain.
- [x] Pertahankan UUID polos agar key lama kompatibel; prefix baru tidak diperlukan untuk migrasi ini.
- [x] Cleanup orphan produksi hanya tersedia dengan `--apply` dan cutoff eksplisit setelah seluruh domain tercakup.

### B. Skema tidak mencatat provider per objek

- [x] Catat bahwa `storage_key` hanya menyimpan key, bukan driver atau bucket.
- [x] Pilih strategi rilis: **alih global ke Garage/S3-compatible untuk unggahan baru tanpa copy legacy**; metadata lama tetap ada tetapi objek lokalnya tidak otomatis terbaca.
- [x] Tidak ada fallback otomatis ke disk lokal bila key tidak ada di RustFS; objek missing tetap dilaporkan.
- [x] Penyimpanan campuran dan migrasi skema tidak dipakai; seluruh replica memakai endpoint/bucket yang sama saat cutover.

### C. SQL dan object store tidak berbagi transaksi

- [x] Petakan crash window upload, hard-delete, send WhatsApp, dan fetch media historis.
- [x] Unggah generik mengompensasi kegagalan SQL dan mencatat kegagalan delete kompensasi.
- [x] Hard-delete mencatat kegagalan storage; orphan dapat diinventarisasi setelah semua domain dilindungi.
- [x] WhatsApp send/fetch mengompensasi atau meninggalkan orphan yang terdeteksi reconcile; kompensasi delete kini dilog.
- [x] Putuskan **tanpa outbox/worker storage khusus pada fase pertama**: 10 MiB membatasi request; idempotensi, log, dan rekonsiliasi manual dengan cutoff/grace period menutup crash window. Jika kebutuhan SLA retry otomatis muncul, tambahkan worker sebagai fase terpisah.
- [x] Tidak ada antrean operasi/tombstone pada fase pertama; delete idempoten dan key orphan tetap dapat ditemukan dari listing remote.
- [x] Grace period default 24 jam untuk dry-run; penghapusan hanya cutoff operator yang eksplisit.
- [x] Storage unavailable dibedakan sebagai 503, key hilang 404; error operasional dicatat tanpa mengirim detail sensitif ke pengguna.
- [x] Log kegagalan kompensasi dan hasil per key tersedia; metrik agregat/worker retry otomatis bukan bagian implementasi ini.

### D. Batas ukuran dan konsumsi memori berbeda

- [x] Terapkan batas 10 MiB untuk upload UI/API dan media gateway; limit historis 50 MiB tidak lagi menjadi jalur ingress.
- [x] Catat bahwa kontrak buffer membuat request aktif menahan salinan konten di memori.
- [x] Dokumentasikan rumus perencanaan memori: 10 MiB × request bersamaan × salinan buffer × replika; Base64 menambah sekitar 4/3 payload ditambah overhead runtime.
- [x] Tetapkan timeout SDK 3s connect/15s socket dan retry maksimum 3; deployment harus mengatur concurrency/reverse-proxy sesuai resource-nya.
- [x] Putuskan buffer memadai untuk limit saat ini; streaming ditunda sampai kebutuhan >10 MiB terbukti.
- [x] Standar 10 MiB dan pengujian batas tepat di bawah/sama/di atas diterapkan pada ingress generik dan WhatsApp; gateway dibatasi saat streaming.
- [x] Tidak memakai multipart upload untuk objek berukuran maksimum 10 MiB.

### E. Konsistensi metadata dan checksum

- [x] Rute generik menghitung SHA-256 dari bytes yang diterima dan provider menulis SHA-256 yang sama sebagai metadata object.
- [x] `size_bytes` diambil dari panjang byte yang diterima server.
- [x] ETag tidak digunakan sebagai SHA-256; migrator membandingkan checksum isi secara eksplisit.
- [x] Rekonsiliasi checksum membaca objek penuh untuk membandingkan referensi DB dengan konten storage.
- [x] Dokumentasikan bahwa bucket versioning dapat membuat delete marker dan retensi/purge versi lama harus diatur operator; lihat panduan operasi.

## 10. Prosedur cutover yang aman

### Fase 0 — Persiapan cutover tanpa migrasi legacy

- [ ] Pastikan bucket Garage privat, endpoint HTTPS/proxy valid, key hanya mendapat akses bucket yang diperlukan, serta backup/retensi diputuskan pada runtime target.
- [x] Catat bukti development: versi aplikasi/RustFS, endpoint, volume legacy, jumlah replica, dan seluruh tabel pemegang key di [laporan penerimaan Compose](docs/operations/evidence/rustfs-compose-acceptance-2026-10-24.md).
- [ ] Saat rollout, catat nilai runtime production aktual untuk versi, endpoint/TLS, volume, replica, dan tabel pemegang key.
- [ ] Buat snapshot database dan backup volume lokal sebelum cutover untuk retensi/rollback.
- [x] Tidak menghitung/copy inventory legacy karena pemilik mengizinkan berkas lokal lama tidak tersedia setelah cutover.
- [x] Catat exception legacy tersebut; missing key lama setelah cutover bukan kehilangan objek baru yang tak terjelaskan.

### Fase 1 — Tidak ada bulk copy pada keputusan saat ini

- [x] Migrator `attachments:migrate-to-s3` tetap tersedia sebagai jalur opsional jika keputusan preservasi legacy berubah; tidak dijalankan pada cutover ini.

### Fase 2 — Sinkronisasi akhir dan alih trafik

- [x] Lakukan maintenance singkat saat mengubah backend global; dual-write tidak diperlukan karena tidak ada copy legacy.
- [x] Key legacy tidak diwajibkan ada di object store aktif; dokumentasikan legacy yang sengaja ditinggalkan.
- [x] Uji API/ORM live terhadap Garage untuk unggah, baca, hapus, otorisasi lampiran baru, dan simpan-baca media WhatsApp; tes memakai database uji dan membersihkan object unik.
- [x] Samakan konfigurasi Compose production API, jobs worker, scheduler, dan outbox worker lewat env anchor S3; validasi konfigurasi Compose berhasil.
- [ ] Terapkan konfigurasi tersebut pada seluruh replica production secara serentak; verifikasi tidak ada replica dengan driver berbeda.
- [ ] Pantau upload/download/delete, latensi, error signature, kapasitas bucket, dan respons 404/5xx.
- [x] Pertahankan volume lokal read-only selama S3 aktif; Compose sudah memvalidasi mount legacy read-only.
- [ ] Siapkan dan verifikasi backup DB sebelum deployment production serta pertahankan salinannya selama jendela rollback.

### Fase 3 — Penerimaan dan penutupan

- [x] Jalankan rekonsiliasi lintas domain pada Compose development historis; empat referensi media WhatsApp yang hilang berasal dari 2026-10-23 (sebelum cutover development 2026-10-24), tanpa orphan dan tanpa delete.
- [x] Ulangi rekonsiliasi setelah tes live API membersihkan objek; hasil tetap tanpa orphan/penghapusan dan bucket tidak berisi objek uji tersisa.
- [x] Pisahkan key lampiran lokal non-UUID ke `unsupportedReferences`; tidak dihitung sebagai missing atau orphan RustFS.
- [x] Tidak membuat manifest migrasi legacy pada mode ini; simpan hasil penerimaan unggahan baru sebagai baseline.
- [x] Lakukan restore drill aplikasi development dan uji pulih object Garage dari salinan kedua pada bucket yang sama; [laporan menjelaskan batas failure-domain](docs/operations/evidence/garage-live-acceptance-2026-10-24.md). Backup offsite dan restore production tetap belum dibuktikan.
- [x] Simpan tanggal penerimaan development/tes Garage, versi, pengecualian legacy, dan hasil verifikasi di laporan evidence; checksum manifest migrasi tidak berlaku karena tidak ada migrasi legacy.
- [ ] Setelah rollout, simpan tanggal cutover production, versi aktual, pengecualian, dan hasil verifikasi runtime.
- [ ] Hapus volume sumber hanya setelah jendela rollback berlalu dan backup terverifikasi.

### Rollback

- [x] Dokumentasikan pemicu rollback: readiness/storage error, dampak latency, integritas object, dan kegagalan operasional.
- [x] Rollback ke driver lokal memerlukan reverse-sync objek baru dari Garage; mengganti env saja membuat upload baru tidak tersedia.
- [x] Rollback tidak cukup mengganti env; sinkronkan perubahan dengan maintenance dan verifikasi.
- [x] Pertahankan kedua salinan sampai rekonsiliasi/validasi selesai.

## 11. Matriks kegagalan dan tindakan

| Kegagalan                                  | Dampak yang mungkin                          | Respons aplikasi                                 | Pemulihan                                    |
| ------------------------------------------ | -------------------------------------------- | ------------------------------------------------ | -------------------------------------------- |
| Timeout saat upload                        | Objek mungkin tersimpan meski respons hilang | Error terkontrol; retry key yang sama harus aman | Retry idempoten lalu rekonsiliasi            |
| Upload sukses, insert DB gagal             | Objek orphan                                 | Kompensasi delete; catat bila kompensasi gagal   | Retry cleanup setelah grace period           |
| DB hard-delete sukses, delete RustFS gagal | Objek orphan tanpa baris attachment          | Log kegagalan; orphan melewati grace period      | Rekonsiliasi manual dry-run lalu apply       |
| RustFS down saat download                  | Objek bisa ada tetapi tak terjangkau         | 502/503, bukan 404 palsu                         | Retry/backoff dan monitor                    |
| Objek benar-benar hilang                   | Baris DB masih menunjuk key                  | 404 dan alert integritas                         | Restore backup atau investigasi              |
| Patch `media_key` gagal                    | Objek WhatsApp orphan                        | Error tercatat dengan key untuk cleanup          | Rekonsiliasi lintas domain                   |
| Key WhatsApp tidak masuk reconcile         | Media valid dianggap orphan                  | Larang apply cleanup                             | Tambahkan referensi WhatsApp dan tes regresi |
| Policy/kredensial salah                    | Operasi storage gagal                        | Preflight/startup gagal tanpa membocorkan secret | Perbaiki policy atau rotasi key              |
| Checksum migrasi berbeda                   | Objek tujuan salah/korup                     | Jangan tandai `verified`                         | Salin ulang atau investigasi sumber          |

## 12. Definisi selesai yang dapat diaudit

- [x] Driver S3 hanya aktif dengan konfigurasi lengkap dan tervalidasi; secret tidak masuk log/response aplikasi.
- [x] Kedua domain memakai provider bersama; contract tests dan API tests dengan provider palsu membuktikan tulis/baca/hapus.
- [x] Otorisasi unduh resource tetap dijalankan sebelum membaca objek.
- [x] Key UUID lama tetap digunakan tanpa migrasi skema.
- [x] Rekonsiliasi melindungi setiap domain yang memakai provider bersama.
- [x] Error storage dibedakan dari objek hilang dan jalur log/reconcile terdokumentasi; retry delete otomatis belum ada.
- [x] Crash window memiliki kompensasi atau jalur orphan reconcile yang eksplisit.
- [x] Migrator menyediakan dry-run, batch resume, checksum, laporan; prosedur cutover/reverse-sync terdokumentasi.
- [x] Batas 10 MiB diuji pada API generik dan WhatsApp tepat pada batas serta di atas; payload Base64 berkapasitas 15 MiB diterima.
- [x] Bucket privat, kontrol akses Garage per-bucket, TLS, backup/restore, dan retensi didokumentasikan; backup offsite dan pemulihan production belum diverifikasi.
- [x] Sumber lokal tidak pernah dihapus oleh migrator dan hanya boleh dihapus operator setelah masa rollback.
- [x] Laporan migrasi opsional dan prosedur audit tersedia; tidak membuat inventaris legacy karena pemilik memilih meninggalkannya. Bukti production tetap menunggu secret/policy deploy dan restore drill.

---

Provider S3-compatible, batas UI/API 10 MiB, API/ORM, rekonsiliasi, migrator opsional, dan tes live Garage untuk attachment serta media WhatsApp telah diverifikasi. Request live membuktikan TLS, signing SigV4, region `garage`, path-style, serta operasi bucket yang diperlukan; bukti dan batas tes tercatat di [laporan Garage](docs/operations/evidence/garage-live-acceptance-2026-10-24.md). Yang belum selesai adalah rollout API pada runtime production, uji payload 15 MiB melalui reverse proxy API production, backup database/object store ke failure-domain terpisah, restore production/offsite, monitoring/retensi, dan penutupan masa rollback. Checklist membedakan implementasi yang sudah terbukti dari gate operasional yang belum dijalankan.
