# M6 — Kartu kerja terperinci

Baca [protokol eksekusi](EXECUTION.md) terlebih dahulu. Status resmi tetap di [master checklist](../../ROADMAP.md); dokumen ini menjelaskan pekerjaan, bukan bukti bahwa fitur sudah ada. Path output yang belum ada adalah usulan deliverable. Semua path kode relatif terhadap root repository.

## M6.01 — Buat struktur docs: quickstart, architecture, addon development, API, models, Board, jobs/outbox, security, troubleshooting, recovery, release/upgrade.

- **Prasyarat:** M0.07
- **Baca/periksa:** README; package READMEs; ADR; feature matrix.
- **Deliverable:** docs content tree dan navigation config.

### Langkah pelaksanaan

1. Buat navigasi docs yang memisahkan tutorial/how-to/reference/explanation.
2. Untuk setiap halaman catat pembaca, prasyarat, commands dan expected output.
3. Tulis minimal quickstart/architecture/addon tutorial/troubleshooting sebelum referensi otomatis.

### Verifikasi dan syarat selesai

Pengguna baru dapat mengikuti quickstart dengan test env; halaman tidak hanya placeholder headings.

Catat command/test case, actual result, SHA sumber dan lokasi bukti dalam `docs/roadmap/evidence/M6.01.md` sesuai template. Jika kemampuan eksternal belum tersedia, pisahkan implementasi lokal yang selesai dari aktivasi yang terblokir; jangan centang item penuh. Jangan menonaktifkan check yang gagal agar item dianggap selesai.

## M6.02 — Buat generator deterministik package/scripts/env schema/model/field/relasi/menu/access/seed dan referensi endpoint yang benar-benar valid.

- **Prasyarat:** M0.01, M4.01
- **Baca/periksa:** Manifest/model definitions; env schema; route schemas; package scripts.
- **Deliverable:** scripts/docs generation modules dan generated references.

### Langkah pelaksanaan

1. Bangun extractor tanpa start app, connect DB, load real .env atau mutate registry secara tak terkendali.
2. Urutkan output stabil; redact defaults yang sensitif; derive reference dari schema yang benar.
3. Tambahkan fixture generator untuk unknown type/optional/relations dan consistency API.

### Verifikasi dan syarat selesai

Dua run sama menghasilkan byte sama; field/endpoint docs cocok source; invalid extraction gagal jelas.

Catat command/test case, actual result, SHA sumber dan lokasi bukti dalam `docs/roadmap/evidence/M6.02.md` sesuai template. Jika kemampuan eksternal belum tersedia, pisahkan implementasi lokal yang selesai dari aktivasi yang terblokir; jangan centang item penuh. Jangan menonaktifkan check yang gagal agar item dianggap selesai.

## M6.03 — Pisahkan blok generated README dari penjelasan manual; jangan overwrite seluruh dokumen.

- **Prasyarat:** M6.02
- **Baca/periksa:** README manual sections; docs generator.
- **Deliverable:** README partial generator.

### Langkah pelaksanaan

1. Tentukan marker BEGIN/END GENERATED untuk packages/scripts/version references.
2. Ganti hanya isi marker dan fail jika marker hilang/duplikat.
3. Pertahankan bahasa/overview/manual quickstart di luar marker.

### Verifikasi dan syarat selesai

Test before/after menjaga teks manual identik; missing markers tidak menyebabkan overwrite file.

Catat command/test case, actual result, SHA sumber dan lokasi bukti dalam `docs/roadmap/evidence/M6.03.md` sesuai template. Jika kemampuan eksternal belum tersedia, pisahkan implementasi lokal yang selesai dari aktivasi yang terblokir; jangan centang item penuh. Jangan menonaktifkan check yang gagal agar item dianggap selesai.

## M6.04 — Standardisasi docs:generate, docs:check, docs:build, docs:links; gagal saat hasil generator stale.

- **Prasyarat:** M6.02, M6.03
- **Baca/periksa:** Generator M6.02/M6.03; root scripts.
- **Deliverable:** Root docs command contract.

### Langkah pelaksanaan

1. Tambahkan generate/check/build/links yang dapat berjalan lokal dan CI.
2. Mode check render ke temp lalu bandingkan tanpa memperbarui tracked file.
3. Kembalikan exit nonzero untuk stale output dan list file yang perlu generate.

### Verifikasi dan syarat selesai

Ubah schema fixture membuat docs:check fail; generate lalu check pass.

Catat command/test case, actual result, SHA sumber dan lokasi bukti dalam `docs/roadmap/evidence/M6.04.md` sesuai template. Jika kemampuan eksternal belum tersedia, pisahkan implementasi lokal yang selesai dari aktivasi yang terblokir; jangan centang item penuh. Jangan menonaktifkan check yang gagal agar item dianggap selesai.

## M6.05 — Uji contoh executable dan tautan internal; link eksternal memakai kebijakan retry agar gangguan pihak lain tidak membuat flakiness berlebihan.

- **Prasyarat:** M6.01
- **Baca/periksa:** Docs code fences/examples; link map.
- **Deliverable:** Docs examples tests dan link checker.

### Langkah pelaksanaan

1. Pindahkan runnable examples ke fixtures yang diimport/test agar tidak drift.
2. Validasi local paths/anchors saat build; jadwalkan external link checks dengan retry terbatas.
3. Laporkan unreachable external URL berbeda dari broken internal link.

### Verifikasi dan syarat selesai

Contoh addon compile/install pada DB test; typo internal anchor gagal CI.

Catat command/test case, actual result, SHA sumber dan lokasi bukti dalam `docs/roadmap/evidence/M6.05.md` sesuai template. Jika kemampuan eksternal belum tersedia, pisahkan implementasi lokal yang selesai dari aktivasi yang terblokir; jangan centang item penuh. Jangan menonaktifkan check yang gagal agar item dianggap selesai.

## M6.06 — Buat portal responsif dengan search, base path repository, 404, branding, dan katalog UI.

- **Prasyarat:** M6.01, M5.02, M5.03
- **Baca/periksa:** Docs framework pilihan; assets/ui; repository path.
- **Deliverable:** Documentation portal.

### Langkah pelaksanaan

1. Pilih static documentation stack yang cocok reuse React UI dan catat tradeoff.
2. Implementasikan search, sidebar, 404, responsive layout dan base /moonwitness-xiv/.
3. Pisahkan docs branding dari Board business code.

### Verifikasi dan syarat selesai

Nested URL reload, search keyboard dan 404 bekerja pada static preview.

Catat command/test case, actual result, SHA sumber dan lokasi bukti dalam `docs/roadmap/evidence/M6.06.md` sesuai template. Jika kemampuan eksternal belum tersedia, pisahkan implementasi lokal yang selesai dari aktivasi yang terblokir; jangan centang item penuh. Jangan menonaktifkan check yang gagal agar item dianggap selesai.

### Catatan implementasi

Portal saat ini berada di `apps/docs`, memakai guide bundle deterministik, React Router basename
`/moonwitness-xiv/`, Markdown renderer tanpa raw HTML, pencarian keyboard, dan fallback `404.html`.
CI wajib menjalankan `pnpm test:docs-portal`. Publikasi Pages dan build source ref stable tetap
menjadi acceptance terpisah M6.07/M6.08.

## M6.07 — Gunakan Actions artifact untuk Pages tanpa branch tambahan; dev hanya menghasilkan preview artifact.

- **Prasyarat:** M6.06, M0.04
- **Baca/periksa:** .github/workflows; Pages repository settings.
- **Deliverable:** pages.yml dan verified Pages configuration.

### Langkah pelaksanaan

1. Konfigurasi Pages source GitHub Actions (repository sekarang: `build_type=workflow`) dan workflow upload/deploy artifact dengan permissions sempit.
2. Dev build preview artifact saja; trusted main/release mempublikasikan setelah perubahan workflow dipromosikan.
3. Gunakan concurrency group tunggal Pages agar publish tidak balapan; jangan create gh-pages.

### Verifikasi dan syarat selesai

Workflow artifact memiliki index dan base paths benar; `build-info.json` merekam SHA checkout. Hosted preview M6.07 pada `0ce59ed` lulus dan mengunggah artifact. Published source SHA tetap harus dibuktikan dari deployment pertama pada trusted main/release.

Catat command/test case, actual result, SHA sumber dan lokasi bukti dalam `docs/roadmap/evidence/M6.07.md` sesuai template. Jika kemampuan eksternal belum tersedia, pisahkan implementasi lokal yang selesai dari aktivasi yang terblokir; jangan centang item penuh. Jangan menonaktifkan check yang gagal agar item dianggap selesai.

## M6.08 — Publikasikan dokumentasi stable yang sesuai release; tentukan retensi versi dokumentasi dan URL latest.

Stable docs disimpan sebagai arsip deterministik `docs-site-vX.Y.Z.tar.gz` pada GitHub Release immutable, lalu Pages merakit `/vX.Y.Z/` untuk lima stable release terbaru. `/latest/` hanya mengarah ke stable release paling baru apabila arsip docs-nya tersedia; `/` adalah selector, `/next/` memuat main, dan dev tetap hanya menghasilkan preview artifact. Arsip lama tetap berada di Release walau keluar dari lima path aktif Pages. Hosted acceptance masih pending karena belum ada stable release yang dipublikasikan pada repo.

- **Prasyarat:** M7.02, M6.06
- **Baca/periksa:** Release version contract; docs portal.
- **Deliverable:** Docs version manifest.

### Langkah pelaksanaan

1. Gunakan URL `/vX.Y.Z/`, alias `/latest/`, selector root, dan lima snapshot stable terbaru pada Pages.
2. Build dari tag stable Release yang sudah published, pastikan tag reachable dari main, serta tampilkan kanal, versi aplikasi dan link source.
3. Buat arsip USTAR/gzip reproducible, canonicalize metadata run-specific, validasi checksum/path saat extract, dan simpan arsip ke Release tanpa overwrite.
4. Compose Pages dari inventory GitHub Release aktual; asset reuse harus cocok digest dan ukuran. Dokumen main ditempatkan di `/next/`; dev tidak memperoleh publish permission.
5. Scan gabungan seluruh output sebelum artifact Pages diunggah; catat manifest `docs-versions.json` beserta SHA source dan retensi.

### Verifikasi dan syarat selesai

Retensi semver dan archive/extract/compose diuji lokal termasuk corrupt archive dan missing latest; browser build/test berjalan pada root repo dan nested stable base path. Deploy mensyaratkan Pages artifact hasil compose; belum menyatakan milestone hosted-complete sampai ada stable release dan publish berhasil.

Catat command/test case, actual result, SHA sumber dan lokasi bukti dalam `docs/roadmap/evidence/M6.08.md` sesuai template. Jika kemampuan eksternal belum tersedia, pisahkan implementasi lokal yang selesai dari aktivasi yang terblokir; jangan centang item penuh. Jangan menonaktifkan check yang gagal agar item dianggap selesai.

## M6.09 — Scan konten publik agar tidak berisi secret, data pribadi, real environment values, atau internal artifacts.

- **Prasyarat:** M6.04, M6.06
- **Baca/periksa:** Generated docs; stories; built site output.
- **Deliverable:** Docs publication safety check.

### Langkah pelaksanaan

1. Scan output termasuk source maps/JSON/static examples untuk sentinel secrets dan private fixtures.
2. Jangan copy .env, auth state, internal logs atau database dumps ke public output.
3. Gunakan fabricated identities dan jelaskan sample values.

### Verifikasi dan syarat selesai

Injected secret fixture menyebabkan publish check fail; output public allowlist terverifikasi.

Catat command/test case, actual result, SHA sumber dan lokasi bukti dalam `docs/roadmap/evidence/M6.09.md` sesuai template. Scan bersifat pattern-based, maka tetap sertakan review konten; jika pemeriksaan external belum tersedia, pisahkan implementasi lokal dari aktivasi yang terblokir. Jangan menonaktifkan check yang gagal agar item dianggap selesai.

## M6.10 — Docs-only changes dapat dipublikasikan setelah verifikasi tanpa memaksa release aplikasi; source SHA harus terlacak.

- **Prasyarat:** M6.07, M7.01
- **Baca/periksa:** Changed paths; version classifier; Pages flow.
- **Deliverable:** Docs-only publishing path.

### Langkah pelaksanaan

1. Klasifikasikan hanya `docs/**/*.md`, `README.md`, dan `ROADMAP.md` sebagai konten docs-only; generator, script, app source, workflow, manifest, lockfile, JSON dan assets adalah executable/config/code changes.
2. Jalur branch main menunggu check run terbaru `ci-gate` untuk SHA yang persis sama sebelum upload atau deploy. Perubahan generator tetap menjalani required CI dan tidak diberi label docs-only.
3. Pastikan release classifier menghasilkan `none` untuk docs-only commit; jangan jalankan release/tag/version bump. Tulis application version dan source SHA/ref terpisah di `build-info.json`.

### Verifikasi dan syarat selesai

Docs typo fix tidak membuat tag aplikasi dan hanya publish setelah full `ci-gate` success pada SHA tersebut; executable/code change tidak lolos docs-only classifier dan tetap memerlukan full validation.

Catat command/test case, actual result, SHA sumber dan lokasi bukti dalam `docs/roadmap/evidence/M6.10.md` sesuai template. Jika kemampuan eksternal belum tersedia, pisahkan implementasi lokal yang selesai dari aktivasi yang terblokir; jangan centang item penuh. Jangan menonaktifkan check yang gagal agar item dianggap selesai.

## M6.11 — Pisahkan retry Pages dari release aplikasi; kegagalan docs tercatat dan tidak menghasilkan tag/version baru.

Pages dapat di-dispatch ulang dengan full main commit SHA dari incident report. Workflow mengecek source sebagai commit lengkap, mewajibkan ancestry terhadap `main` dan `ci-gate` sukses pada exact SHA, lalu rebuild dari checkout detached SHA tersebut. Jalur ini hanya menjalankan Pages, tanpa tag/version/release atau image publication. Workflow contract tests pass lokal; deploy gagal lalu retry hosted masih acceptance pending.

- **Prasyarat:** M6.07, M7.13
- **Baca/periksa:** Pages workflow; release state manifest.
- **Deliverable:** Pages retry runbook dan test fixtures.

### Langkah pelaksanaan

1. Pisahkan docs publish status dari image/tag assets dan sediakan dispatch retry pada release SHA.
2. Retry menggunakan artefak yang sama atau rebuild terdokumentasi dari source immutable.
3. Laporkan failure ke summary/issue yang sama tanpa release bump.

### Verifikasi dan syarat selesai

Simulasi deploy-pages gagal lalu retry menghasilkan site benar dan hanya satu release.

Catat command/test case, actual result, SHA sumber dan lokasi bukti dalam `docs/roadmap/evidence/M6.11.md` sesuai template. Jika kemampuan eksternal belum tersedia, pisahkan implementasi lokal yang selesai dari aktivasi yang terblokir; jangan centang item penuh. Jangan menonaktifkan check yang gagal agar item dianggap selesai.
