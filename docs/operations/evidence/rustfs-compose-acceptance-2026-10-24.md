# Bukti penerimaan RustFS Compose — 2026-10-24

Catatan ini adalah bukti historis RustFS development. Konfigurasi production kemudian berubah ke Garage HTTPS; penerimaan live Garage terbaru ada di [laporan Garage](garage-live-acceptance-2026-10-24.md). Gate pada bagian bawah di bawah ini merujuk konfigurasi saat laporan historis ini dibuat.

## Cakupan

Penerimaan ini mencakup workspace development Compose, bukan deploy production. Service object storage yang diuji adalah RustFS pada image `rustfs/rustfs:1.0.3`; API memakai `ATTACHMENT_STORAGE_DRIVER=s3`, endpoint internal `http://storage:9000`, path-style addressing, dan bucket privat `moonwitness-attachments`. Port host RustFS hanya terikat ke loopback untuk development.

Versi aplikasi yang diuji `1.0.0-rc.1` (HEAD workspace saat itu `6e2618a`). API berjalan satu replica. Volume object store Compose adalah `moonwitness-xi_object_data`; volume lokal lama `moonwitness-xi_whatsapp_dev_attachments` tetap dipertahankan.

Pemilik object key yang direkonsiliasi adalah `attachments.storage_key` dan `whatsapp_messages.media_key`. Volume lokal pada runtime Compose berisi 0 file (4 KiB direktori) saat diperiksa; volume tetap dipertahankan dan tidak dihapus.

Tidak ada secret atau credential yang dicatat di file ini.

## Hasil uji

- `/readyz`: HTTP 200, `status=healthy`, `database=connected`, `attachmentStorage=connected`.
- API/ORM dengan RustFS live dan database uji: lampiran berhasil diunggah, diunduh dengan byte yang sama, lalu dihapus melalui endpoint API. Tes memeriksa akses terautentikasi dan objek setelah delete tidak ditemukan.
- WhatsApp API dengan RustFS live dan database uji: media outbound berhasil disimpan, lalu dibaca melalui endpoint media API dengan byte yang sama.
- Kedua tes menghapus objek RustFS unik setelah selesai; API suite dan paket storage diuji ulang pukul 08:38 WIB.
- API acceptance suite terkait: 2 file lulus, 25 tes lulus (diulang pukul 08:38 WIB).
- `@moonwitness/orm-storage`: 2 file lulus, 14 tes lulus, 1 tes dilewati (mencakup copy-to-backup, delete sumber, restore, dan verifikasi byte).
- Build TypeScript API lulus; image Compose API dibangun dari workspace.
- Restore drill development: dump PostgreSQL custom-format berhasil dipulihkan ke database sementara terisolasi; jumlah lampiran/media setelah restore sama (`1`/`4`), lalu database sementara dan dump dihapus (08:38 WIB).
- Restore drill aplikasi penuh `pnpm test:restore-drill` lulus melalui Docker PostgreSQL 16: database source/target sintetis terisolasi dibuat dan dibersihkan, konfirmasi database yang salah ditolak tanpa mengubah sentinel, fixture dan pemeriksaan relasi/login lolos. Backup 1.763 ms, restore 4.186 ms, file backup mode `0600`. Drill ini tidak menetapkan RPO/RTO production.
- Restore drill objek RustFS berhasil: object uji disalin ke bucket backup sementara, sumber dihapus, object dipulihkan dari salinan, lalu byte diverifikasi identik; bucket dan object uji dibersihkan (08:38 WIB). Backup bucket ini berada pada instance RustFS development yang sama, jadi bukan salinan off-host/offsite.
- Compose development dan production lolos validasi konfigurasi. Overlay production meneruskan driver, endpoint, dan bucket yang sama ke API serta jobs worker, scheduler, dan outbox worker. Validasi production memakai placeholder untuk memeriksa bentuk konfigurasi; production tidak dijalankan dengan placeholder.
- Compose production memvalidasi API dan seluruh worker menggunakan driver `s3`; volume legacy API terpasang read-only, console dinonaktifkan, dan port host RustFS tidak dipublikasikan.
- Preflight credential production: 5 tes lulus. Template `.env.production.example` ditolak karena credential wajib masih kosong; output hanya menyebut nama variabel dan tidak memuat nilai secret.

## Rekonsiliasi saat penerimaan

Perintah dry-run `attachments:reconcile --limit=100` dijalankan sesudah tes live:

- Referensi RustFS hilang: 4 key UUID dari media WhatsApp. Seluruh pesan pemilik referensi dibuat pada 2026-10-23, sebelum penerimaan/cutover development 2026-10-24; ini merupakan legacy lokal yang sengaja tidak disalin sesuai keputusan pemilik.
- `unsupportedReferences`: 1 key lampiran legacy non-UUID; dikecualikan dari pemeriksaan object store aktif.
- `corrupt`: 0.
- Objek yang dipindai: 0; orphan: 0; terhapus: 0; kegagalan: 0.

Tidak ada objek legacy yang dihapus oleh penerimaan ini. Tidak ada migrasi bulk yang dijalankan.

## Gerbang yang masih terbuka

- Rollout production Garage memakai key aplikasi yang hanya diberi akses bucket terkait; kredensial disediakan melalui secret manager dan bucket harus privat.
- Verifikasi readiness dan upload/baca/hapus pada runtime production sebenarnya. Uji konfigurasi production di atas hanya memvalidasi Compose dengan placeholder.
- Uji reverse proxy/WAF production menerima body WhatsApp sampai 15 MiB dan API tetap menolak file mentah di atas 10 MiB.
- Jalankan serta catat backup PostgreSQL dan bucket ke target terpisah/offsite, kemudian restore drill production ke lingkungan terisolasi dan cocokkan checksum. Drill development di atas hanya membuktikan alur restore lokal.
- Tetapkan pemantauan error, latensi, kapasitas, dan masa retensi/rollback sebelum menghapus volume lokal.

Tidak ada endpoint, credential, policy production, hasil backup/restore, atau hasil proxy production yang diasumsikan oleh bukti development ini.
