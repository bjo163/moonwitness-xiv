# Arsip metode delivery — 2026-10-15

Arsip historis; aturan operasional aktif ada di [EXECUTION.md](EXECUTION.md) dan prioritas saat ini ada di [ACTIVE-PLAN.md](ACTIVE-PLAN.md). Pernyataan status, push per task dan antrean CI di bawah bukan instruksi aktif. Tidak ada task atau acceptance yang dihapus.

# Jalur rilis aktif

**Diperbarui: 2026-10-15; baseline lokal PostgreSQL tercatat pada `dev` SHA `2b4de58c4fcb9bb09f19c38ec9583209e00d95e3`.** Goal penuh mencakup 148 M-series dan 65 K-series (213 task terindeks); M-series tetap utuh dan pekerjaan K-series terpisah. `pnpm roadmap:progress -- --format json` saat ini: 106 complete, 11 running, 94 todo, 2 blocked. K1-004 sudah diterima secara lokal; K1-003 dan task turunannya tetap menunggu approval hak sumber K0-004. Snapshot tepat-SHA diperbarui setelah batch ini. Jalur rilis pertama adalah jalur prioritas, bukan pengganti roadmap. Percepatan mengurangi pengulangan dan mengurutkan dependensi; tidak mengurangi acceptance.

## Metode aktif yang disetujui — 2026-10-15

Prioritas goal: tuntaskan jalur rilis inti API/Board, akses, seed/setup, PostgreSQL, panduan penggunaan dan required gates. Ekspansi knowledge/AI serta addon opsional tetap di backlog sampai dependency/approval siap; jangan menjadikannya syarat tambahan rilis inti. Goal penuh tetap tercatat.

- Satu batch perilaku dengan acceptance jelas; commit lokal atomik, push sekali per batch. Saat kandidat CI berjalan, lanjutkan lokal dan antrekan push agar run tidak dibatalkan.
- Gunakan verification ladder di EXECUTION.md sebagai sumber aturan. Jangan mengulang full verify, matrix visual/DB atau audit menyeluruh tanpa perubahan input terkait.
- Setelah build package terdampak, jalankan `pnpm release:preflight:built` sebelum push kandidat: manifest Docker, diagram arsitektur dan kontrak roadmap. Command hanya membaca; generated drift diperbaiki sebelum push. Ini tidak menggantikan typecheck, lint, test perilaku, security atau approval wajib.
- Satu kandidat stabil untuk required hosted gates. Catat hasil gagal dan reproduksi lane terkait; pekerjaan lokal independen terus berjalan. Tidak ada promosi main atau deployment produksi sebelum syarat rilis terpenuhi.
- Batasi pekerjaan aktif menjadi satu pelaksana untuk file bersama; paralel hanya pada kepemilikan file yang terpisah. Jangan audit ulang item yang sudah memiliki bukti valid; blocker eksternal memiliki owner dan syarat buka kembali.

## Temuan bottleneck yang terukur — 2026-10-15

- PR promosi #51 memakai CI penuh karena targetnya `main`. Run `38738130172` pada SHA `413a994` berjalan 3 menit 47 detik lalu berakhir `cancelled` ketika head PR sudah maju ke `2b4de58`; beberapa lane telah menyelesaikan setup, install dependency, instal Chromium, container build/scan, dan mulai tes. Dengan `cancel-in-progress: true`, push baru membuang kerja lama dan memulai kandidat penuh lagi.
- Run exact-SHA `38738386455` untuk `2b4de58` selesai: quality, PostgreSQL integration/restore, browser, UI, containers/security, semua automation suites, CodeQL, dan Gitleaks lulus. `ci-technical-gate` gagal karena assertion `scripts/ci-concurrency.test.mjs` mencari `echo`, sedangkan workflow dengan sengaja memakai `printf`; perbaikan assertion lokal sudah lulus pada 26/26 gate tests. Jadi penyebabnya test policy stale, bukan runner atau aplikasi; source perbaikan menunggu batch push berikutnya.
- Tetap buat commit kecil/atomik untuk riwayat review dan rollback. Namun ketika PR promosi terbuka, kumpulkan beberapa commit yang berbagi sumber/dependensi menjadi satu vertical slice sebelum push. Saat full candidate CI sedang berjalan, lanjutkan coding dan commit lokal independen, tetapi antrekan push sampai run selesai supaya tidak membatalkan bukti yang sedang dikumpulkan. Jika perubahan mendesak harus dipush, terima bahwa full verification akan mulai ulang pada head baru.
- Jangan samakan “boleh lanjut bekerja” dengan “perlu push setiap task”. Lanjutkan implementasi lokal tanpa menunggu CI; jadikan batas push sebagai batas batch yang masuk akal. Setiap push tetap menghasilkan SHA dan menjalankan checks; release kandidat tetap harus melewati semua required gates.
- Untuk perubahan lokal, satu focused behavior test atau validator plus typecheck/lint terdampak sudah cukup. Jangan ulang unit, build, full browser, PostgreSQL, visual matrix, security scan, atau docs portal jika source yang dicakup tidak berubah. Satu run exact-SHA kandidat menggantikan verifikasi kandidat terpisah per kartu.
- Pada source `2b4de58`, `pnpm test:integration` telah membangun workspace dan lulus 15/15 PostgreSQL integration/performance tests terhadap PostgreSQL 16.15 dalam 120.97 detik. Suite memakai schema acak yang dibersihkan; jangan mengulang pada batch dokumen.

## Checkpoint percepatan terbaru — 2026-10-15

Goal penuh tetap aktif: 148 M-series master cards dan 65 K-series cards. Untuk mempercepatnya, bedakan **kode lokal**, **bukti satu kandidat**, dan **aktivasi/approval eksternal**; jangan membuat test atau implementasi baru hanya karena checkbox masih terbuka.

- Batch terbaru menutup deduplikasi redelivery issue-intake secara lokal: kode `882d7d2c0fda0b786a2520bfa8303eea1d2d68e5` dan evidence/roadmap `2cee8e98968e16f4cd7f2e31d9e805c7dc5bc0bb` sudah ada di `origin/dev`. Roadmap suite 99/99, focused issue-intake/workflow-trust 40/40, workflow-trust 24/24, lint, format, actionlint dan action-pin checks lulus. Batasnya jelas: ledger Actions hanya menjamin dedup tujuh hari, gagal tertutup pada inventory tak lengkap, dan hosted pilot menunggu App/retention/promosi protected.
- `M3.11`: Board PostgreSQL suite sudah lulus pada ketiga engine lokal; jangan mengulang matrix. Sisa penerimaan adalah scheduled hosted run dari `main` dan review artifact.
- `M8.09`: incident automation dan regression lokal sudah ada; jangan membangun handler/test kedua untuk kasus sama. Sisa penerimaan memerlukan workflow tepercaya di `main` dan fault/recovery hosted.
- `M9.03` dan jalur fungsional `M9.06`: runtime, seed, API, worker, PostgreSQL dan Board journey sudah punya bukti. Jangan refresh seluruh integration/E2E hanya untuk docs/evidence; sisa exact-candidate/security/CODEOWNER harus dikumpulkan bersama kandidat atau oleh owner.
- `M9.08`: graph dan bundle budget sudah terbukti; controlled historical size comparison tetap di backlog sampai ada baseline setara atau ekstraksi besar baru. Jangan mengarang perbandingan.
- Tidak ada hosted CI yang perlu ditunggu sebelum mengerjakan perubahan lokal independen. Pada batch roadmap-only, validasi roadmap, tes roadmap, format dan link docs cukup; test aplikasi hanya dijalankan bila source/perilaku aplikasi berubah.

### Urutan kerja setelah checkpoint

1. **Lanjutkan lokal:** untuk tiap task terbuka, baca hanya acceptance/task card dan evidence terakhir. Kerjakan jika ada gap implementasi lokal yang konkret dan berdampak pada jalur release; gabungkan task yang memakai source dan bukti sama. Jika tidak ada gap lokal, pindahkan tindak lanjut ke blocker/backlog dengan owner serta syarat buka kembali, tanpa mengulang audit.
2. **Satu release candidate:** setelah perubahan lokal release-critical berhenti, catat satu SHA `dev`; jalankan release planner dan required exact-SHA technical/security/PostgreSQL/Board/container checks sekali pada kandidat itu. Perubahan source yang membatalkan bukti mengharuskan hanya lane terdampak diulang; perubahan docs/evidence saja tidak membatalkan tes aplikasi.
3. **Promosi terlindungi:** CODEOWNER/repo admin meninjau exact head, security owner memberi disposition temuan privat/historis, lalu PR `dev` → `main` menyelesaikan required gates. Tidak ada bypass, promosi otomatis tanpa syarat, atau deployment aplikasi.
4. **Penyelesaian automation/release:** setelah kandidat dipromosikan, gunakan run hosted yang sama untuk membuktikan Pages, tag/version/changelog/artifact/provenance dan issue lifecycle yang relevan. Jangan membuat release rehearsal terpisah per kartu bila satu run memenuhi acceptance beberapa kartu.
5. **Lanjutkan backlog penuh:** item non-release tetap di roadmap; kerjakan setelah rilis pertama atau saat pemicu di `EXECUTION-BACKLOG.md` terpenuhi. Tidak ada kartu yang dihapus atau dianggap selesai hanya karena dipindahkan.

### Kriteria berhenti agar tidak berputar

- Satu batch maksimal satu gap perilaku yang nyata; sebelum mengedit, sebutkan task, acceptance yang gagal, file pemilik, dan satu command pembuktian utama.
- Jangan menjalankan ulang `pnpm verify`, semua browser, semua PostgreSQL integration, release parity, atau audit visual karena SHA berubah oleh docs saja. Jalankan suite menyeluruh sekali pada kandidat; bila gagal, reproduksi lane gagal saja.
- Setiap batch berhenti setelah diff direview, pemeriksaan terdampak lulus, commit/push `dev` terverifikasi, dan SHA dicatat. Sesudah push, lanjut ke batch independen tanpa menunggu hosted CI.
- Jangan mengubah status master untuk mengejar angka; checkbox hanya berubah jika acceptance task terpenuhi. Blocker eksternal bukan alasan untuk menahan pekerjaan lokal lain dan bukan alasan untuk membuat mock pengganti aksi hosted.

## Perubahan cara mencapai goal agar cepat selesai

Goal penuh tetap satu goal, tetapi antrean kerja dibagi tegas menjadi tiga jalur: **rilis pertama** (hanya dependency dan acceptance yang mencegah kandidat rilis), **lokal independen** (implementasi/perbaikan yang bisa dituntaskan tanpa akses pihak lain), dan **tertahan eksternal/post-release** (tidak boleh mengambil waktu dari dua jalur pertama). Jangan mengerjakan 213 task secara serial dan jangan menganggap setiap kartu butuh implementasi atau test baru: gunakan implementasi/evidence bersama jika memang memenuhi acceptance tiap kartu.

- **Setiap sesi mulai dari satu snapshot:** `git status`, SHA `dev`, dan status checklist. Pilih satu kartu lokal dengan dependency siap serta acceptance gap terkecil yang berdampak pada rilis. Jangan menjalankan ulang inventarisasi besar atau mengulang planning semata-mata karena sesi baru dimulai.
- **Batas kerja lokal:** satu perubahan fungsional yang bermakna per batch; kartu terkait boleh ditutup bersama jika bukti yang sama memenuhi seluruh acceptance. Bila pemeriksaan awal menemukan tidak ada gap lokal, catat blocker dan pindah pada sesi yang sama—jangan memperpanjang audit, membuat fixture/model/addon, atau menunggu hosted CI.
- **Batas verifikasi:** satu focused test/lane untuk perilaku yang berubah ditambah lint/typecheck terdampak. Full exact-SHA release gates dijalankan satu kali pada kandidat final. Hanya ulang lane yang gagal atau yang input/source-nya berubah; test yang lulus pada source dan input identik tetap berlaku.
- **Tidak ada paralelisme semu:** gunakan beberapa worker hanya untuk pekerjaan dengan file dan dependency yang benar-benar terpisah. Pada checkout bersama, jangan menugaskan beberapa penulis ke roadmap, manifest/lockfile, konfigurasi CI, atau evidence yang sama; jika isolasi tidak tersedia, kerjakan berurutan tanpa menunggu CI.
- **Keluar dari antrean aktif secara jujur:** akses, approval, secret rotation, Pages/Release hosted run, atau operator eksternal dicatat sebagai blocker dengan pemilik, prasyarat, dampak, dan bukti penutup. Item post-release tetap tercatat beserta syarat pembuka. Pemindahan status ini mengubah urutan, tidak menghapus kartu atau acceptance.
- **Definisi satu batch selesai:** perubahan + targeted checks + review diff + commit/push `dev` + catatan SHA/verifikasi. Sesudah push, langsung lanjut ke batch independen berikutnya; satu snapshot hosted di checkpoint cukup, kecuali ada alert atau check gagal.

## Batas waktu dan aturan berhenti mengulang

Kesan pekerjaan tiga hari berulang datang dari dua sumber berbeda: sebagian catatan evidence historis memang mencatat refresh parity beberapa kali pada SHA baru, sedangkan quality/browser/integration/container CI adalah lane terpisah yang menguji kegagalan berbeda. Jangan mengulang lane kedua tanpa alasan; perbaiki temuan aktualnya.

- **Iterasi biasa:** satu test yang membuktikan perubahan, lint/typecheck package terdampak bila kode berubah, lalu review diff. Perubahan docs/generated cukup `pnpm docs:check:built` setelah artifact dibangun dan `pnpm test:roadmap` jika roadmap ikut berubah. Jangan jalankan `pnpm verify`, release-plan parity, seluruh suite, atau browser matrix untuk perubahan docs-only.
- **Generated docs:** bangun input sekali, jalankan `pnpm docs:generate`, kemudian gunakan `pnpm docs:check:built` dan bila perlu `pnpm docs:build:built`. Hindari pasangan `pnpm docs:generate` + `pnpm docs:build` yang masing-masing membangun semua package; gabungkan dalam satu `pnpm docs:build` hanya ketika perlu membuktikan seluruh Pages artifact.
- **Area aplikasi:** jalankan focused suite dan PostgreSQL/Chromium journey hanya bila kode API/ORM/Board/setup yang relevan berubah. Satu hasil tetap berlaku selama source dan input terkait identik.
- **Kandidat rilis:** seluruh required exact-SHA checks tetap berjalan satu kali, termasuk typecheck, lint, security, PostgreSQL, browser, container, artifact/provenance dan approval. Jangan melewati gate untuk mengejar waktu.
- **Batas refresh evidence:** jangan menjalankan release prepare/dry-run hanya untuk mengganti fingerprint dokumentasi. Refresh parity sekali setelah ada perubahan material pada release policy atau input versi/changelog, bukan di setiap batch.
- **Parallel CI:** jalankan pekerjaan lokal independen saat CI berlangsung. Job CI yang berbeda tetap tunggu sebagai evidence kandidat; jika gagal, ambil langkah gagal saja dan reproduksi lokal satu kali. Jangan mengulang seluruh workflow untuk satu kegagalan.

Pada 2026-10-15, hosted quality menemukan empat generated reference stale. Output di-refresh dan `pnpm docs:build` lulus; hasil docs check setelah build lulus, `pnpm test:roadmap` lulus 94/94, dan PostgreSQL canonical integration suite lulus 15/15 pada DB disposable yang kemudian dihapus. Commit perbaikan docs ada pada SHA `9cc1cfce82886a1738e2547e7416a59f1760b173`. Tidak perlu mengulang suite tersebut untuk perubahan dokumentasi lain kecuali source/input-nya berubah atau exact-SHA candidate mewajibkannya.

## Diagnosis dan aturan percepatan

Yang membuat pekerjaan terasa berulang adalah: acceptance per model meski memakai guard yang sama; menjalankan ulang seluruh suite setelah perubahan dokumentasi atau perubahan test terisolasi; menjalankan release-plan parity pada setiap batch; menunggu CI hosted sebelum mulai pekerjaan lokal independen; serta menghitung audit visual, audit platform, dan ekspansi addon sebagai prasyarat rilis.

Untuk setiap batch, jalankan hanya tes yang membuktikan perilaku yang berubah, typecheck/build dan lint pada paket terdampak, serta pemeriksaan roadmap/diff bila dokumen evidence berubah. Gunakan hasil sebelumnya hanya jika source SHA dan input terkait identik. Jalankan rangkaian wajib lengkap sekali pada kandidat rilis exact-SHA. CI mulai setelah push dan tidak menahan kerja lokal lain. Jangan menghapus typecheck, lint, tes keamanan, gate wajib, PostgreSQL acceptance, atau CODEOWNER approval.

`pnpm verify` sekarang menggunakan build hasil typecheck untuk suite unit/docs/architecture pada run yang sama. Pertahankan jalur tersebut; jangan menambahkan build ulang tanpa perubahan input atau runner baru. Jangan mengulang browser matrix lintas engine dan seluruh fixture otorisasi untuk kontrak yang sudah terbukti.

Tes kebijakan automation di CI dibagi menjadi empat suite matrix paralel (`workflow`, `release`, `roadmap`, `platform`). Semuanya wajib lulus ketika terpilih; selector hanya menjalankan automation untuk perubahan shared config/script, `ROADMAP.md`, serta `docs/roadmap/**`, bukan perubahan package atau dokumentasi biasa yang sudah memiliki lane terdampak. Perubahan dengan source tak terklasifikasi tetap memilih quality, dan kegagalan membaca diff/workspace memilih full scope. Pemisahan gate memungkinkan lifecycle issue memakai hasil semua lane teknis exact-SHA tanpa menunggu CODEOWNER. `ci-gate` tetap status wajib promosi dan tetap menegakkan approval sensitif. CI teknis untuk `dev` berjalan melalui PR `dev` → `main`; push `dev` tidak lagi mengulang suite yang sama. Lifecycle memilih hanya run PR same-repository dengan head `dev`, base `main`, dan SHA persis saat ini. Push `main`, security scans pada PR/push `main`/jadwal/manual, dan Pages preview tetap tersedia. Pastikan ruleset `dev` tidak mensyaratkan status check sebelum mempertahankan penghapusan trigger push CI `dev`; ruleset yang terbaca saat migrasi hanya mensyaratkan check pada `main`.

## Jalur utama menuju rilis pertama

| Urutan                  | Pekerjaan yang harus ditutup                                                                                                                                                                                     | Pemilik                     | Kriteria selesai                                                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Candidate source     | Pilih satu SHA `dev`; pastikan tree bersih, version/changelog plan konsisten, tidak ada perubahan aplikasi tertinggal.                                                                                           | Maintainer lokal            | Satu SHA kandidat tercatat; tidak ada bump/release pada batch dokumentasi atau bukti.                                                      |
| 2. Core dan akses       | Pertahankan setup programmatic dan seed `system`, `superadmin`, serta contoh partner; tinjau hanya keluarga guard yang berbeda: tenant/company parent, admin grant, append-only audit, dan attachment lifecycle. | API/auth                    | Tiap keluarga punya satu kasus positif dan satu penolakan persisted yang relevan; tidak ada duplikasi per-model untuk jalur sama.          |
| 3. PostgreSQL dan Board | Pakai PostgreSQL lokal yang sudah tersedia. Jalankan canonical integration suite dan satu Chromium happy-path alur utama pada kandidat yang berubah.                                                             | API/Board                   | Seeded user login, akses company-scoped, alur request/approval tersimpan, audit/event terbukti; disposable DB dibersihkan.                 |
| 4. Keamanan             | Tinjau ulang temuan secret historis, rotasi bila terpapar, tetapkan pemilik incident/privacy, dan verifikasi pemindaian exact-SHA.                                                                               | Security owner + repo admin | Tidak ada temuan kredensial tanpa disposition; scanner wajib pass. Bukti histori memerlukan owner/security access.                         |
| 5. Docs dan Pages       | Periksa quickstart install/seed/login/Board dan hasil publik terhadap SHA kandidat; pertahankan source scan.                                                                                                     | Docs maintainer             | Pengguna baru dapat mengikuti alur; tautan/output aman dan build-info sama dengan kandidat. Pages dipublikasi setelah promosi terlindungi. |
| 6. Release gates        | Jalankan workflow kandidat satu kali: typecheck, lint, required unit/integration/browser/security checks; validasi artifact, SBOM/provenance, digest, changelog dan retry.                                       | Release maintainer + CI     | Semua required checks lulus untuk exact SHA dan artifact sama; tidak ada deployment aplikasi.                                              |
| 7. Promosi dan trace    | Tunggu review CODEOWNER dan branch protection, promosi melalui PR, lalu verifikasi release/Pages/issue projection.                                                                                               | CODEOWNER/repo admin        | Tidak ada bypass; release status baru complete sesudah artifact ada dan trace SHA cocok.                                                   |

Langkah 2–6 boleh dikerjakan paralel selama tidak mengubah file bersama. Dalam checkout yang sama, satu penulis untuk roadmap, root manifest, lockfile, dan evidence yang sama. Hindari membuat agent bekerja pada file bersama.

## Blocker yang memang menunggu pihak luar

- **CODEOWNER/repository admin:** review PR promosi, aturan branch dan required checks. Dampak: `main` tidak dapat diperbarui.
- **Security owner/admin:** disposition temuan kredensial historis, credential rotation, serta akses ke private alert/SARIF. Dampak: security readiness belum dapat dinyatakan selesai.
- **GitHub Actions permissions/admin:** token `issues:write`, Pages/schedule settings, akses log privat atau disposable hosted resources. Dampak: apply issue sync, publikasi Pages, dan hosted fault rehearsal menunggu. Dry-run serta konfigurasi lokal tetap boleh dikerjakan.
- **Data/privacy owner dan storage operator:** retention/legal-hold dan ketahanan provider. Dampak: klaim kebijakan retensi atau durability provider tidak dibuat sebelum owner/provider dipilih.

Tidak satu pun blocker tersebut alasan untuk menahan pekerjaan lokal independen. Jangan menulis langsung ke GitHub dengan melewati workflow yang memeriksa SHA, lifecycle snapshot, batching, dan serialisasi.

## Backlog: ditunda, bukan dihapus

Lihat daftar dan kondisi pembukaan kembali di [backlog yang ditunda](EXECUTION-BACKLOG.md). Kartu tetap tercatat pada roadmap; backlog ini mencegahnya menghambat rilis pertama.

## Bukti reusable dan pemilihan batch berikutnya

PostgreSQL canonical suite lulus 15/15 pada exact source `203d29a05fedcf8c3b34b2303fa71b9df5bb0681`; focused Chromium request journey lulus di source aplikasi `5cff67d`, yang tidak berubah sampai `203d29a`. Jangan ulang suite ini kecuali source aplikasi terkait berubah atau kandidat final memerlukan hosted exact-SHA acceptance. Jangan membuat fixture/model atau refresh plan baru hanya untuk menambah jumlah bukti. Untuk batch selanjutnya, pilih kartu lokal dengan gap acceptance paling kecil dan dependency sudah tersedia; bila seluruh gap lokal kartu itu ternyata sudah dibuktikan, pindahkan sisanya ke blocker/backlog dan lanjut tanpa memperpanjang audit. Setelah perubahan, jalankan cek terarah, review diff, commit dan push ke `dev`, catat SHA dan hasil; hosted CI tetap verifikasi asinkron.

## Goal eksekusi yang diperbarui — jalur tercepat tanpa mengurangi cakupan

Goal rilis tetap aktif. Untuk menghindari empat hari kerja berputar, gunakan status `in_progress` sebagai daftar penerimaan yang belum lengkap, bukan instruksi untuk mengulang implementasi atau suite yang sudah lulus. Audit status/evidence sekali di awal batch; setelah itu kerja berdasarkan dependency dan gap acceptance berikut.

### Keputusan metode per 2026-10-15

- Jangan menunggu hosted CI untuk memulai task lokal independen. Satu batch lokal dikerjakan sampai diff reviewed dan commit/push `dev`; catat hasil CI belakangan dalam checkpoint, bukan sebagai gerbang antrean.
- Gunakan satu pelaksana untuk file bersama (ROADMAP, tasks index/schema, lockfile, workflow atau root config). Paralelkan hanya audit read-only atau edit pada file yang tidak tumpang tindih; merge hasil sekali dan jalankan validasi gabungan sekali.
- Sebelum test, cocokkan evidence dengan source SHA + input dependency. Bukti tetap reusable saat perubahan hanya docs/evidence. Setelah ada perubahan source, jalankan test paling sempit; naikkan ke test package/build/integration hanya bila boundary berubah atau hasil sempit gagal.
- Jangan buat “evidence-only batch” untuk merekam hasil yang sudah dicatat. Tambahkan ringkasan di history/evidence yang memang menjadi deliverable perubahan; satukan pembaruan roadmap, validasi dan commit.
- Satu failed lane boleh direproduksi satu kali secara terarah. Jika gagal kedua kali dengan penyebab lingkungan/akses, dokumentasikan blocker dan lanjutkan task lokal lain; jangan ulang full suite.
- Tidak ada daftar tunggu polling CI. Snapshot GitHub cukup sekali per checkpoint atau setelah event/action nyata; unresolved permission, hosted workflow, approval dan remote write masuk blocker ber-owner.
- Tetap wajib: lint/typecheck terdampak, tes keamanan yang berlaku, PostgreSQL acceptance yang belum reusable, required CI untuk kandidat exact-SHA dan CODEOWNER review. Tidak ada skip/bypass demi kecepatan.

### Protokol percepatan v2

- **Kerjakan outcome vertikal, bukan kartu satu per satu.** Ambil 3–5 task siap yang berbagi perilaku, owner file, dan acceptance; satu implementasi boleh menutup beberapa kartu hanya jika buktinya mencakup acceptance masing-masing. Jangan pecah perubahan kecil menjadi banyak commit atau banyak siklus setup.
- **Batasi investigasi sebelum bertindak.** Audit awal maksimal 20 menit dan satu bukti utama per kartu. Setelah menemukan gap konkret, implementasikan. Jika tidak ada gap lokal, tulis bukti yang sudah ada dan dependency yang masih kurang; pindahkan sisanya ke blocker/backlog lalu pilih task siap berikutnya.
- **Pilih task dengan nilai penutupan tertinggi.** Dahulukan ready P0/release blocker yang punya perubahan lokal; setelah itu pilih kumpulan task dengan acceptance bersama. Jangan memulai kartu yang masih menunggu dependency, owner approval, hardware atau credential jika ada task independen yang siap.
- **Gunakan paralel hanya jika mengurangi wall time.** Paralelkan audit read-only atau batch di worktree terisolasi dengan daftar file dan acceptance yang berbeda. Jangan paralelkan edit ke ROADMAP, task index/schema, lockfile, workflow yang sama, atau shared checkout; jika batas file beririsan, satu pelaksana yang menulis.
- **Gunakan verification ladder, bukan full suite per commit.** Docs/roadmap: formatter + validator/test roadmap + link checker yang terdampak. Package: focused test + lint + typecheck package. Perubahan kontrak lintas package/database: tambahkan integration yang relevan. Kandidat release exact-SHA: satu kali semua required gates. SHA docs-only tidak membatalkan bukti runtime.
- **Beri batas pada kegagalan lingkungan.** Reproduksi lane gagal satu kali dengan command lebih sempit. Jika tetap terhambat karena OS, service, registry, credential atau akses remote, jangan polling/retry tanpa perubahan kondisi: rekam command, hasil, pemilik eksternal dan next trigger; lanjut ke batch lokal lain. Gate tetap harus lulus sebelum promosi.
- **Kurangi antrean review eksternal.** Kumpulkan permintaan approval/akses menjadi satu daftar checkpoint dengan owner, link, exact permission dan acceptance. Periksa ulang sekali per checkpoint atau saat event berubah; tidak ada ping/poll berulang untuk status yang sama.
- **Selesaikan setiap vertical slice.** Jalankan pemeriksaan, review seluruh diff, commit dan push `dev`, verifikasi remote SHA; kemudian mulai slice ready berikutnya meski hosted CI sebelumnya masih berjalan. Satu reporter memegang staging/commit/push agar batch paralel tidak saling menimpa.

### Checkpoint lokal saat ini

- Reconcile roadmap M/K: task index memuat 213 task (148 M-series + 65 K-series). Perbaikan progress report yang sebelumnya mengunci total lama dan Issue planner untuk format K-series lulus `pnpm test:roadmap` 109/109, `pnpm automation:check:roadmap` (213 task), focused issue/progress tests 40/40, Prettier, dan `git diff --check`.
- Tinjauan dependency `@fastify/rate-limit` 11.2.0 → 11.2.1 tidak dipromosikan: unit/build/typecheck, PostgreSQL 15/15, Board E2E 23 passed (satu flaky lulus pada retry), docs portal 5/5, container smoke, image build, audit production dan Trivy 0.76.0 image scans tanpa CRITICAL lulus lokal. Workspace Trivy scan tidak selesai pada volume checkout Windows; perubahan dependency dikembalikan ke versi source. Bila dibuka lagi, jalankan di workflow resmi Ubuntu agar workspace dan kedua image dipindai bersama.
- Aturan percepatan: jangan ulang gate lokal di atas jika source dan input tidak berubah. Untuk batch roadmap/docs jalankan roadmap tests + formatter/link check; untuk perubahan kode jalankan tes perilaku terkait + lint/typecheck package terdampak. Jalankan full required gates sekali pada kandidat exact-SHA.

### Aturan fast path mulai batch ini

- **WIP lokal maksimum satu batch.** Pilih satu kartu atau satu kelompok kartu yang berbagi kode dan acceptance; jangan membuka audit baru sebelum batch itu punya hasil, diff yang direview, dan keputusan berikutnya.
- **Urutan tiap batch:** tulis gap acceptance yang belum terbukti → ubah hanya area terkait → jalankan satu focused test dan lint/typecheck package terdampak bila kode berubah → review diff → commit/push `dev` → catat SHA dan hasil. Tes tambahan hanya jika hasil pertama gagal atau ada perubahan lintas batas yang belum dibuktikan.
- **Bukti dipakai ulang.** Bukti valid selama source dan input yang diuji tidak berubah. SHA commit yang maju karena docs/evidence saja tidak membuat PostgreSQL, Board, security, atau browser suite perlu diulang. Untuk kandidat rilis, jalankan required exact-SHA gate sekali.
- **Pindahkan pekerjaan tanpa jalur lokal keluar dari antrean aktif.** Jika satu-satunya gap adalah approval, hak akses, secret rotation, Pages/Release hosted run atau operator eksternal, catat pemilik, URL/kebutuhan akses, dampak, dan exit evidence pada blocker/backlog; lanjut ke kartu lokal independen. Jangan membuat simulasi tambahan untuk menggantikan aksi hosted.
- **Batas berhenti eksplorasi.** Jangan menambah model, fixture, addon, benchmark, atau bukti naratif baru kecuali kartu tertentu membutuhkan perilaku itu dan ada acceptance terukur yang belum terpenuhi. Tutup pekerjaan berdasarkan bukti, bukan banyaknya command atau panjang evidence.
- **Tidak ada antrean CI.** Setelah satu push, lanjutkan batch lokal berikutnya; ambil satu snapshot hosted saat checkpoint atau saat ada perubahan status/alert. Reproduksi hanya lane gagal yang konkret. Semua gate tetap harus lulus sebelum promosi.

### Release blockers (menahan promosi, bukan pekerjaan lokal)

1. **M10.03 — exact-SHA gates dan promosi:** setelah memilih kandidat `dev`, tunggu semua check wajib untuk SHA/PR kandidat, PostgreSQL, browser dan container, lalu review CODEOWNER; jangan merilis atau mempromosikan sebelum seluruh policy lulus. Pemilik: maintainer + CODEOWNER. Bukti tutup: hasil check pada SHA yang dipromosikan dan verifikasi ref `main`.
2. **M8.03/M8.11 — security disposition:** minta security owner/admin memeriksa alert/SARIF privat, temuan secret historis, status rotasi/revokasi, private reporting dan pemilik respons. Pemilik: security owner/repo admin. Bukti tutup: disposition tertulis untuk tiap finding dan kanal/role operasional terverifikasi. Scan lokal yang bersih tidak menggantikan ini.
3. **M6.08 — stable docs:** tunggu rilis stabil pertama dan Pages production run; manifest/retensi lokal dan test-nya sudah ada. Pemilik: release maintainer. Bukti tutup: arsip versi di Release, alias latest dan Pages cocok dengan versi/SHA rilis.

### Bisa dikerjakan lokal sekarang (urut dependensi, tanpa menunggu CI)

1. **M3.11:** workflow browser matrix sudah tersedia di `main` dan menerima `workflow_dispatch`. Lokal, seluruh engine/PG coverage sudah tercatat; gap tunggalnya adalah satu eksekusi dari `main` dan review artifact. Jangan jalankan ulang browser suite lokal. Periksa run terjadwal/dispatch yang ada sekali; bila belum ada dan konektor mengizinkan, dispatch satu kali; jika tool/izin tidak tersedia, pindahkan ke blocker GitHub Actions dengan URL workflow. Tutup hanya setelah semua engine pass dan artifact aman ditinjau.
2. **M8.09:** periksa kontrak planner/reconciler dan uji dry-run lokal yang belum punya evidence pada source saat ini. Jika workflow/code sudah lengkap, jangan membuat ulang: rekam evidence lokal singkat dan tunggu aktivasi default-branch/`issues:write`. Tutup setelah scheduled reconcile menghasilkan upsert/resolve yang terverifikasi tanpa duplikasi/spam.
3. **M9.03 + M9.06:** perlakukan sebagai satu jalur acceptance addon karena M9.06 bergantung pada engine M9.03. Implementation, seed, API, expiry, dan perjalanan PostgreSQL/Board sudah ada; audit hanya gap yang belum terbukti untuk source saat ini, tanpa membuat model/fixture baru. Jika tidak ada gap lokal material, jangan refresh suite: tandai sisa exact-SHA/review sebagai blocker dan lanjut.
4. **M9.08:** jangan mengejar angka before/after lama yang tidak punya baseline setara. Pertahankan bukti graph, consumer dan route budget yang ada; minta owner menetapkan apakah hasil tersebut cukup atau tunggu baseline sebelum ekstraksi berikutnya. Perlakukan sebagai keputusan owner/backlog, bukan pekerjaan implementasi rilis.

### Approval/akses GitHub yang harus diberi pemilik

| Kebutuhan                                                               | Pemilik yang diminta      | Dampak                                                        | Jalur lokal sementara                                             |
| ----------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------- |
| CODEOWNER review dan merge PR promosi                                   | CODEOWNER/repo admin      | Menahan perubahan `main` dan M10.03                           | Lanjut audit lokal dan siapkan bukti kandidat; jangan bypass      |
| Private alerts/SARIF, security reporting dan disposition historis       | Security owner/repo admin | Menahan penutupan M8.03/M8.11                                 | Pertahankan fail-closed policy dan catat bukti scan yang tersedia |
| `workflow_dispatch`, Actions artifact/log dan Pages production settings | GitHub Actions admin      | Menahan acceptance terjadwal M3.11/M8.09 dan rilis docs M6.08 | Validasi workflow/test lokal sekali; jangan mengulang suite       |
| `issues:write` untuk reconciler issue                                   | GitHub Actions admin      | Menahan remote upsert/resolve M8.09                           | Jalankan planner/dry-run dan cek deduplikasi lokal                |

### Item post-release/backlog

M9.08 controlled size comparison tetap ditunda sampai ada baseline same-runner/toolchain sebelum ekstraksi berikutnya atau owner produk menerima graph/size budgets sebagai keputusan final. Ekspansi addon di luar request/approval, audit visual/browser yang telah lulus, rehearsal lifecycle penuh M11.14, serta eksperimen fault/recovery yang memerlukan akses privat tidak menahan rilis pertama; syarat pembuka masing-masing tetap tercatat di `EXECUTION-BACKLOG.md`. Tidak ada item roadmap yang dihapus.

### Batas batch agar tidak mengulang pekerjaan

- Satu batch harus menyebut kartu, gap acceptance, file/jalur, satu focused command, serta bukti hasil. Bila audit memperlihatkan implementasi sudah benar dan yang tertinggal remote, batch lokal berhenti pada pencatatan gap; pindah ke item lokal independen.
- Jangan menjalankan suite aplikasi, browser matrix, `pnpm verify`, `release:prepare`, atau audit penuh hanya untuk memperbarui timestamp/fingerprint evidence. Gunakan ulang bukti bila source dan input relevan tidak berubah. Jalankan hanya failed lane setelah kegagalan.
- Untuk docs/roadmap saja: jalankan validasi roadmap dan formatting yang relevan. Untuk workflow saja: workflow policy tests/linter terarah. Jalankan full required gates satu kali pada kandidat final; tetap wajib, tidak boleh dilewati.
- Satu status snapshot GitHub per checkpoint; jangan polling berulang tanpa perubahan status. CI asinkron berjalan sesudah push dan tidak menghentikan batch lokal independen.
- Tiap batch selesai dengan review diff, commit dan push ke `dev`, lalu catat SHA serta pemeriksaan lokal. Jangan membuat branch ketiga atau mempromosikan ke `main` di luar PR/gate yang berlaku.

### Definisi selesai goal

Goal penuh belum selesai hanya karena implementasi lokal atau CI `dev` lulus, dan tidak selesai hanya dengan merilis subset awal. Selesai setelah seluruh 148 kartu M-series master checklist dan 65 kartu K-series memiliki acceptance/evidence yang sesuai, semua required owner/hosted blocker ditutup melalui akses dan gate resmi, promosi protected serta siklus version/release/docs/Pages/issue trace dibuktikan, dan tidak ada kartu yang diam-diam dipindahkan keluar dari scope. Post-release/backlog adalah urutan pengerjaan setelah rilis pertama, bukan pengecualian dari goal.
