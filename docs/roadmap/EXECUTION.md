# Protokol eksekusi untuk agen

## 1. Konteks minimum

Project merupakan pnpm monorepo dengan API Fastify, ORM Objection/Knex, PostgreSQL, dan React/Vite Board. Baca file sumber untuk memastikan versi dan kontrak aktual; jangan mengandalkan ringkasan ini untuk memilih API dependency.

Scope aktif adalah menuntaskan jalur rilis pertama pada [active release plan](ACTIVE-PLAN.md). Seluruh roadmap (148 M-series + 65 K-series) tetap menjadi tujuan jangka panjang, tetapi kartu post-release tidak dikerjakan sebagai antrean prasyarat rilis. Ikuti [backlog tertunda](EXECUTION-BACKLOG.md) untuk item yang menunggu pemicu; jangan mengulang pekerjaan backlog tanpa pemicu tersebut.

Jika pelaksanaan sudah diminta, kerjakan kartu dalam scope yang diotorisasi. Tidak perlu menanyakan kembali keputusan yang sudah eksplisit: dua branch main/dev, tidak ada deploy aplikasi, typed strict, programmatic schema/seed, dan identitas UI reusable. Keputusan stable release pertama tetap ditangani sesuai M7.03.

## 2. Pilih batch lokal berikutnya tanpa menunggu CI

1. Baca `git status --short --branch` dan status master roadmap. Jangan reset atau membuang perubahan yang tidak dibuat sendiri.
2. Gunakan [active release plan](ACTIVE-PLAN.md) untuk memilih pekerjaan yang dependency lokalnya siap. Jangan menunggu hosted CI batch sebelumnya untuk memulai tugas independen.
3. Pisahkan hasil menjadi release blocker, local work, external approval/access, dan post-release backlog. Setiap blocker eksternal harus punya owner, kebutuhan akses, acceptance, dan dampak; kerjakan bagian lokalnya secara paralel.
4. Baca kartu, source files, related tests, evidence task sebelumnya, lalu konfirmasi file dengan `rg --files`. Output baru pada kartu adalah rencana, bukan bukti file tersedia.
5. Pecah kartu besar menjadi batch dengan batas file dan acceptance yang dapat direview. Catat pemilik file dan dependensi sebelum mengubah kode.
6. Jalankan beberapa audit atau task hanya ketika batas file benar-benar terpisah. Gunakan worktree terisolasi jika tersedia dan sesuai aturan hanya `main`/`dev` di remote. Di checkout bersama, lakukan audit read-only paralel atau edit file berbeda dengan pemilik tunggal; serialkan staging, commit dan push.

## 3. Pola pengerjaan setiap kartu

1. **Inspect:** temukan kontrak publik, caller dan tes existing.
2. **Implement:** buat perubahan terkecil untuk satu batch; reuse primitive yang benar dan pertahankan tipe ketat.
3. **Verify locally:** jalankan tes paling relevan, lint/typecheck package terdampak, serta integration saat kontrak lintas-package berubah.
4. **Review:** baca seluruh diff untuk secret, explicit `any`, unsafe assertion, debug, duplikasi, undocumented public change dan generated drift.
5. **Record:** tulis actual command/result, tests yang tidak dapat dijalankan dan alasannya, dependency eksternal, serta source SHA. Jangan mencatat pass sebelum command benar-benar selesai.
6. **Deliver batch:** commit atomik lokal; gabungkan perubahan terkait menjadi satu batch push ke `dev` tanpa force. Verifikasi remote SHA dan catat run ID. Aturan ini menjadi acuan bila catatan lama meminta push per task.
7. **Continue:** segera lanjutkan pekerjaan lokal independen tanpa menunggu hosted CI. Serialkan tindakan remote yang berbagi writer atau dapat membatalkan bukti: tunggu issue-sync apply selesai sebelum push yang memilih task berikutnya; jangan dispatch ulang stale batch setelah batas retry tercapai; jangan membuat PR/tag/release bersamaan. Untuk CI biasa, push batch berikutnya hanya jika batch itu siap dan ada alasan perubahan; push baru dengan sadar mengganti kandidat exact-SHA dan membatalkan penerimaan CI kandidat lama. Hosted CI memverifikasi hasil, bukan antrean untuk mulai kerja lokal.
8. **Close:** centang master hanya setelah semua acceptance lengkap. Jika external activation belum terjadi, item tetap unchecked/partial dengan owner dan exit condition.

### Verification ladder untuk menghindari suite berulang

| Jenis perubahan                    | Gate lokal yang cukup untuk batch                                | Naikkan ke gate lebih luas hanya jika                                                                 |
| ---------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Docs, roadmap, evidence            | Prettier pada file berubah, validator/test roadmap, link checker | Generator/output docs atau public guide berubah                                                       |
| Script satu package / planner      | Test file/script terkait dan lint/typecheck yang tersedia        | Kontrak lintas package atau parser/input publik berubah                                               |
| API, ORM, auth, seed               | Test perilaku paling sempit + lint/typecheck package             | Query, transaksi, permission, seed atau schema programmatic berubah; tambahkan PostgreSQL integration |
| Board UI                           | Component/page test + Board lint/typecheck                       | User journey, routing atau server contract berubah; jalankan E2E terkait                              |
| Dependency, runtime, shared build  | Install frozen + focused tests + build affected workspace        | Candidate exact-SHA; jalankan required suite/security/container sekali                                |
| Release, workflow, security policy | Policy/unit tests untuk workflow/script yang berubah             | Kandidat exact-SHA; jalankan semua required hosted gates tanpa bypass                                 |

Jangan mengulang gate yang input, source terdampak, dan runtime-nya identik dengan bukti yang masih berlaku. Catat hubungan source SHA ke evidence; perubahan source yang tidak terkait tidak membatalkan semua evidence. Jika Windows tidak mendukung atau memperlambat scanner/container yang ditetapkan Linux, jalankan scan exact-source pada runner Linux resmi; jangan mengganti scanner atau menyatakan pass dari scan parsial.

Version bump mengikuti release planner dan substantive release batch, bukan setiap commit. Jangan membuat empty commit atau memasukkan file pengguna yang tidak terkait. `main` hanya lewat protected PR setelah required checks dan review; jangan deploy aplikasi. Lihat [kontrak delivery](ISSUE-SYNC-CONTRACT.md).

### Serialisasi Actions issue writer

- Sebelum push, periksa apakah workflow Roadmap issue sync pada `dev` sedang berada di job apply. Jika ya, jangan push atau dispatch run lain yang menulis issue sampai job itu terminal; audit dan coding lokal tetap boleh berjalan.
- Jika apply menunggu CI exact-SHA dan `dev` bergerak, ikuti hanya bounded recovery workflow yang tersedia. Jangan menaikkan retry cap atau mengulang workflow-dispatch manual setelah exhaustion. Pastikan log menyatakan apakah issue write sudah dicapai sebelum menyimpulkan status issue.
- Setelah job terminal, periksa hasil issue projection dan CI SHA terbaru, lalu siapkan satu batch lokal yang sudah terverifikasi dan lakukan satu push. Hindari push evidence-only beruntun saat apply aktif.
- Pengecualian: perbaikan mendesak boleh mengganti kandidat bila ada bug/security blocker; catat SHA lama yang tersupersede, dampak ke gate, dan pastikan apply lama fail-closed sebelum melanjutkan.

## 4. Perintah yang sudah tersedia pada baseline

Verifikasi `package.json` sebelum memakai daftar ini karena implementasi berikutnya dapat mengubahnya.

```powershell
git status --short --branch
pnpm lint
pnpm format:check
pnpm build
pnpm test
pnpm --filter @moonwitness/board typecheck
pnpm --filter @moonwitness/board lint
pnpm --filter @moonwitness/api exec vitest run tests/auth.test.ts
pnpm --filter @moonwitness/orm-base test
git diff --check
```

Perintah root di atas sudah tersedia pada checkout saat ini. Pilih tes paling sempit yang membuktikan perilaku berubah dan jalankan typecheck/lint pada package terdampak. Jangan menjalankan `pnpm verify`, semua browser, atau semua integration berulang kali untuk perubahan docs-only/test-only; gunakan sekali pada kandidat rilis exact-SHA atau saat shared runtime/build/dependency berubah. PostgreSQL test yang skipped tidak membuktikan integration lolos. Strategi lengkap dan kondisi pembukaan ulang ada di [jalur aktif](ACTIVE-PLAN.md) dan [backlog](EXECUTION-BACKLOG.md).

Jangan mencetak `.env`. Baca schema konfigurasi dan nama variable yang diperlukan; gunakan fixture credential sintetis. DB test harus terisolasi dan ditentukan eksplisit. Jangan menjalankan reset password terhadap akun pengguna saat menguji CLI.

## 5. Batas perubahan per jalur paralel

| Jalur        | File utama                                             | Koordinasi wajib                                                                            |
| ------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| A automation | `.github`, `scripts/release`, root scripts/config      | Root package/lockfile, token contract, generation writes                                    |
| B Board      | `apps/board`, E2E specs                                | UI public API dengan E; API fixture dengan C                                                |
| C backend    | `apps/api`, `packages/orm`, `auth`, `jobs`, `orm-base` | Metadata dengan D, fixture dengan B                                                         |
| D docs       | docs portal, docs generator, README                    | Generated source dengan C; assets dengan E                                                  |
| E design     | `packages/ui`, `packages/assets`, katalog              | Migrasi imports Board dengan B; root workspace/lockfile dengan A                            |
| F roadmap    | `docs/roadmap`, roadmap scripts/tests                  | Satu penulis master checklist/active plan; issue writes tunggu exact source dan serialisasi |

File bersama seperti root `package.json`, lockfile, tsconfig, `ROADMAP.md` dan active plan harus punya satu penulis pada saat yang sama. Agen lain mengirim kebutuhan perubahan, bukan menimpa file. Parallel tidak berarti masing-masing membuat branch baru. Commit/push diserialkan pada `dev`; jangan force-push.

## 6. Aturan types dan package

- Public input tidak tepercaya bertipe `unknown` lalu divalidasi; jangan mengganti any dengan cast berantai.
- Definisikan union states yang exhaustif untuk job/release/UI ketika relevan.
- Public exports harus explicit. Consumer tidak deep-import internal file package lain.
- `ui` tidak boleh mengambil data API, membaca auth token, atau mengetahui `base.user`.
- `assets` tidak bergantung React. Wrapper React berada di `ui`.
- Core ORM tidak mengimpor addon bisnis. Addon bergantung core melalui contract.
- Jangan memindahkan implementasi sekaligus mengubah perilaku tanpa test yang membedakan keduanya.

## 7. Jika pemeriksaan gagal

| Kejadian                                  | Tindakan                                                                          |
| ----------------------------------------- | --------------------------------------------------------------------------------- |
| Lint/types gagal                          | Perbaiki penyebab; jangan menonaktifkan rule global                               |
| DB tidak tersedia                         | Laporkan environment, jangan tulis integration pass; gunakan runner DB terisolasi |
| Flaky browser                             | Simpan trace dan diagnosis; retry terbatas tetap dilaporkan                       |
| dev berubah saat bot menulis              | Baca head baru, rebase perhitungan, jalankan ulang verifikasi; jangan force-push  |
| Permission GitHub tidak tersedia          | Selesaikan config/dry-run lokal, tulis permission minimum yang kurang             |
| Tag/aset sudah ada                        | Baca source/digest; lanjut jika identik, berhenti jika berbeda                    |
| Generator mengubah manual docs            | Perbaiki delimiters dan test; jangan menerima overwrite                           |
| Screenshot baseline berubah               | Periksa diff; jangan otomatis update baseline untuk melewatkan test               |
| Aturan dokumen bertentangan dengan source | Catat discrepancy, periksa tujuan pengguna, perbarui plan/ADR dengan alasan       |

## 8. Handoff minimum

Gunakan format berikut agar agen berikutnya tidak perlu membaca seluruh chat:

```text
Task ID:
Status: todo / in-progress / blocked / complete
Source SHA / branch:
Tujuan dan kontrak yang diterapkan:
File yang berubah:
Perubahan belum committed yang perlu dipertahankan:
Command + exit code + ringkasan hasil:
Tests skipped dan alasannya:
Evidence path / CI run:
Masalah tersisa / dependensi eksternal:
Langkah berikutnya yang konkret:
Commit hasil pekerjaan / pushed remote SHA:
GitHub issue / promotion PR / CI status:
```

Selesai coding, selesai verifikasi lokal, dan selesai aktivasi remote adalah tiga kondisi berbeda. Tuliskan kondisi yang sebenarnya.
