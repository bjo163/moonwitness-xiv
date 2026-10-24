# Bukti penerimaan live Garage — 2026-10-24

## Cakupan

Penerimaan menguji provider S3-compatible dari workspace ini terhadap endpoint Garage HTTPS dan bucket yang dikonfigurasi di `.env`. Nilai endpoint, region `garage`, bucket, dan key tidak disalin ke bukti selain nama endpoint/bucket non-secret; access key dan secret tidak dicatat. Tes API memakai database tes lokal, lalu mengirim object ke Garage live. Ini membuktikan jalur SDK, TLS, signing SigV4, bucket access, dan integrasi API/ORM; ini bukan bukti aplikasi sudah di-deploy ke host production.

## Hasil

- `node scripts/verify-attachment-storage-production-env.mjs .env`: valid; output tidak mencetak secret.
- `pnpm --filter @moonwitness/orm-storage exec vitest run tests/s3.test.ts`: 6 tes lulus. Tes live mencakup readiness, put/get/list/delete, dan pemulihan object dari salinan kedua pada bucket yang sama. Key tes acak dibersihkan dalam `finally`.
- `pnpm --filter @moonwitness/api exec vitest run tests/orm.test.ts tests/whatsapp.routes.test.ts` dengan `ATTACHMENT_S3_ACCEPTANCE=1`: 2 file, 27 tes lulus. Lampiran melalui ORM/API berhasil diunggah, dibaca, dan dihapus; media WhatsApp berhasil disimpan ke Garage dan dibaca melalui API. Objek dan baris tes dibersihkan.
- Tes API penuh dengan acceptance aktif: 39 file lulus, 268 tes lulus, 24 dilewati oleh kondisi suite.
- `pnpm --filter @moonwitness/orm-storage test`: 14 tes lulus, 1 dilewati.
- `pnpm test:attachment-storage-production-preflight`: 6 tes lulus, termasuk kewajiban HTTPS.
- `pnpm --filter @moonwitness/orm-storage build` dan `pnpm --filter @moonwitness/api build`: lulus.
- `docker compose ... config --quiet` untuk overlay production: konfigurasi valid dengan nilai placeholder untuk variabel GoWA yang tidak tersedia; output config tidak dicetak.
- Board E2E mobile storage-error/retry mencetak hasil kasus `ok 1`; runner tidak menutup proses wrapper dengan bersih setelah server uji mati, sehingga exit code akhir tidak dapat dipakai sebagai keberhasilan keseluruhan runner.

Tes live berhasil melalui endpoint HTTPS yang dikonfigurasi, sehingga sertifikat dapat dipercaya runtime ini dan request S3/SigV4 diterima oleh endpoint/proxy. Nilai region `garage` serta path-style berfungsi pada request uji.

## Batas penerimaan

- `.env.production` tidak tersedia; overlay Compose production belum dijalankan dan layanan API production belum di-rollout.
- Tes pemulihan menggunakan salinan kedua pada bucket yang sama. Ini menguji alur baca/tulis/pulih, tetapi **bukan backup offsite** atau pemulihan lintas kegagalan bucket/akun/host.
- Belum ada bukti backup PostgreSQL dan bucket ke target berbeda, atau restore drill production dengan checksum.
- Belum ada uji body Base64 15 MiB melalui reverse proxy API production; uji S3 HTTPS di atas hanya memvalidasi proxy Garage.
- Monitoring kapasitas/error, masa retensi, dan jendela rollback production belum diterapkan/dicatat.

Tidak ada operasi delete bucket, perubahan policy, atau penghapusan data pengguna dalam penerimaan ini.
