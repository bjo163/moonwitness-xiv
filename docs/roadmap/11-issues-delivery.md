# M11 — GitHub Issues, delivery dan promotion automation

Jalur F dapat berjalan paralel dengan A–E setelah prasyarat kartu tersedia. Integrasikan dengan M1/M7/M8 yang sudah ada; jangan membuat sistem promosi/release kedua. Baca [kontrak sinkronisasi](ISSUE-SYNC-CONTRACT.md) dan [protokol eksekusi](EXECUTION.md).

## M11.01 — Tetapkan kontrak sinkronisasi roadmap ↔ GitHub Issues dan otoritas setiap field.

- **Prasyarat:** M0.02, M0.04.
- **Baca/periksa:** ROADMAP.md; docs/roadmap/tasks.json; detail cards; GitHub Issues API.
- **Deliverable:** docs/engineering/issue-sync-policy.md.

### Langkah pelaksanaan

1. Pisahkan source-controlled title/scope/dependencies/acceptance dari issue-owned assignee/discussion.
2. Tentukan lifecycle planned/in-progress/blocked/verified-dev/in-main/released; checkbox master berarti acceptance task selesai, bukan otomatis released.
3. Dokumentasikan siapa boleh mengubah field, aturan konflik dan bagaimana issue request diterima kembali ke dev.

### Verifikasi dan syarat selesai

Issue manual close tidak mencentang roadmap tanpa evidence; title edit manusia di generated section ditangani tanpa merusak notes.

Simpan bukti aktual di `docs/roadmap/evidence/M11.01.md`. Jangan menandai aktivasi selesai hanya karena YAML/script sudah ditulis. Saat task selesai, ikuti commit/push protocol; source status dan GitHub issue harus menyebut kondisi yang sama.

## M11.02 — Buat schema task tracking, identitas issue stabil, dan validator silang dokumen.

- **Prasyarat:** M11.01.
- **Baca/periksa:** tasks.json; master checklist; evidence folder.
- **Deliverable:** Task schema, validator dan fixture tests.

### Langkah pelaksanaan

1. Definisikan schema typed untuk id, milestone, detailFile, dependsOn, labels, priority dan optional assignee.
2. Gunakan marker machine-readable repo+task ID pada issue; nomor issue dicari dari remote, bukan hardcoded source utama.
3. Validasi unique ID, missing card, dependency cycle, checkbox/evidence mismatch serta paths aman.

Implementasi minimum: `docs/roadmap/task.schema.json` mendefinisikan task index versioned dan property yang diperbolehkan. `pnpm automation:check:roadmap` memeriksa index aktual terhadap master checklist, card heading dan evidence link; `pnpm test:roadmap` menguji fixture valid, duplicate ID, dependency missing/cycle, path traversal, checkbox drift, malformed metadata dan evidence yang hilang. Marker remote memakai repository ID yang diperoleh dari GitHub API saat apply, bersama Task ID; jangan menyimpan nomor issue atau repository ID fork di tasks.json.

### Verifikasi dan syarat selesai

Task invalid menolak sync sebelum API write; rename title tidak membuat issue baru.

Simpan bukti aktual di `docs/roadmap/evidence/M11.02.md`. Jangan menandai aktivasi selesai hanya karena YAML/script sudah ditulis. Saat task selesai, ikuti commit/push protocol; source status dan GitHub issue harus menyebut kondisi yang sama.

## M11.03 — Buat planner dry-run dan apply mode untuk create/update issue tanpa duplikasi.

- **Prasyarat:** M11.02, M8.01.
- **Baca/periksa:** Task schema; GitHub API adapter; planned scripts/roadmap.
- **Deliverable:** scripts/roadmap sync planner/executor dan tests.

### Langkah pelaksanaan

1. Enumerasi issues open dan closed dengan pagination 100 per halaman; buang pull request entries dan batasi identity ke repository numeric ID yang sedang diproses.
2. Hitung create/update/no-op/conflict berdasarkan marker repo ID + task ID dan konten generated; judul tidak menjadi identity. Duplicate marker atau generated-block yang rusak harus menjadi conflict tanpa mutasi.
3. Pertahankan seluruh isi body di luar managed block (termasuk catatan maintainer), jangan menghapus issue, label manusia atau komentar, dan jangan pernah menjalankan shell berdasarkan issue content.
4. Dry-run menjadi default. Tampilkan source SHA, hash input plan dan daftar operasi; pada repository publik, read-only planning dapat berjalan tanpa credential menggunakan akses anonim. Repository privat memerlukan token read yang sesuai. Mutasi hanya melalui `--apply` eksplisit dengan token scoped dari environment.
5. Sebelum apply, ambil ulang remote state dan tolak plan jika hash berubah. Jalankan API write serial. Jika create timeout, baca ulang marker sebelum mempertimbangkan retry agar create yang sebenarnya sukses tidak menjadi duplikat.
6. Validasi seluruh task/index sebelum remote read/write; fail closed pada autentikasi, rate limit, response invalid, duplicate identity atau malformed generated boundaries.

### Verifikasi dan syarat selesai

Dua apply identik hanya membuat satu issue per ID; timeout create lalu retry menemukan issue yang sudah terbuat. Fixture tests menutup open/closed pagination, pull request filtering, repo scoping, duplicate markers, managed-block preservation yang idempotent meskipun ada catatan maintainer, strict marker validation, stale-plan rejection, no-op idempotence dan ambiguous create recovery. Acceptance remote apply tetap milik pilot/bootstrap M11.14; M11.03 sendiri tidak mengimpor seluruh roadmap.

Simpan bukti aktual di `docs/roadmap/evidence/M11.03.md`. Jangan menandai aktivasi selesai hanya karena YAML/script sudah ditulis. Saat task selesai, ikuti commit/push protocol; source status dan GitHub issue harus menyebut kondisi yang sama.

## M11.04 — Sinkronkan isi issue lengkap, milestone, labels dan dependencies yang dapat ditelusuri.

- **Prasyarat:** M11.03.
- **Baca/periksa:** Kartu per task; milestone definitions; labels API.
- **Deliverable:** Issue templates dan metadata renderer.

### Langkah pelaksanaan

1. Render title [Mxx.yy], tujuan, source SHA/card link, langkah, acceptance, dependencies dan evidence link.
2. Render label `roadmap`, `milestone:<id>`, priority dan label task; buat label/milestone yang belum ada hanya pada apply. Jangan mengubah definisi label atau menghapus label issue yang sudah ada. Resolve assignee melalui GitHub Users API dan gagalkan sync jika akun tidak valid.
3. Gunakan parent/sub-issue/dependency API jika didukung; fallback references/link list jika tidak tanpa memblokir core sync.

### Verifikasi dan syarat selesai

Setiap issue menunjuk kartu tepat dan prerequisites yang ada; descriptions tetap readable tanpa fitur Projects berbayar.

Simpan bukti aktual di `docs/roadmap/evidence/M11.04.md`. Jangan menandai aktivasi selesai hanya karena YAML/script sudah ditulis. Saat task selesai, ikuti commit/push protocol; source status dan GitHub issue harus menyebut kondisi yang sama.

## M11.05 — Pelihara catatan manusia saat bot memperbarui issue.

- **Prasyarat:** M11.03, M11.04.
- **Baca/periksa:** Issue body renderer; managed markers; API update adapter.
- **Deliverable:** Safe body reconciliation tests.

### Langkah pelaksanaan

1. Batasi bot menulis di BEGIN/END managed block; notes di luar marker dipertahankan.
2. Re-read sebelum patch dan deteksi edit bersamaan pada body; retry merge blok terbaru secara terbatas.
3. Jika markers rusak/duplikat, laporkan conflict tanpa overwrite; hindari timestamp berubah yang membuat update tiap run.

### Verifikasi dan syarat selesai

Manual notes dan labels tidak hilang; unchanged task tidak memicu PATCH/comment baru.

Simpan bukti aktual di `docs/roadmap/evidence/M11.05.md`. Jangan menandai aktivasi selesai hanya karena YAML/script sudah ditulis. Saat task selesai, ikuti commit/push protocol; source status dan GitHub issue harus menyebut kondisi yang sama.

## M11.06 — Buat workflow sync terjadwal, push-triggered dan manual dengan batching/rate-limit handling.

- **Prasyarat:** M11.03, M11.05, M8.04.
- **Baca/periksa:** GitHub Actions workflow; API rate limit response; App/token policy.
- **Deliverable:** roadmap-sync workflow dan recovery report.

### Langkah pelaksanaan

1. Trigger trusted dev changes pada roadmap/evidence dan workflow_dispatch; periodic reconciliation untuk missing events.
2. Paginate read, serialize mutations, honor Retry-After/reset headers dan batasi batch untuk initial import.
3. Simpan resumable progress dari remote identity; re-check desired state ketika job dijalankan ulang.

### Verifikasi dan syarat selesai

Bulk import terhenti lalu resume tidak duplicate; 403 permission dibedakan dari throttling; tidak publish secret.

Simpan bukti aktual di `docs/roadmap/evidence/M11.06.md`. Jangan menandai aktivasi selesai hanya karena YAML/script sudah ditulis. Saat task selesai, ikuti commit/push protocol; source status dan GitHub issue harus menyebut kondisi yang sama.

## M11.07 — Implementasikan lifecycle issue berdasarkan evidence, commit, CI, promosi dan release.

- **Prasyarat:** M11.01, M11.06, M2.10.
- **Baca/periksa:** Evidence template; CI result identity; promotion/release manifests.
- **Deliverable:** Issue lifecycle reconciler dan transition tests.

### Langkah pelaksanaan

1. Ambil status `ci-technical-gate` dari workflow CI pada PR same-repository `dev` → `main` dengan exact source SHA; jangan mencampur push, workflow-dispatch, PR fork, base branch lain, atau SHA yang sama pada run lain. Gate ini memvalidasi semua lane teknis terpilih, tetapi tidak menunggu CODEOWNER yang hanya mengatur promosi. Snapshot issue menunggu gate terminal secara terbatas dan fail-closed bila run/job tidak tersedia. `ci-gate` tetap menjadi check wajib promosi. CI push `dev` dihapus karena ruleset `dev` tidak mewajibkannya dan PR tersebut menjalankan lane teknis yang sama.
2. Tetapkan status verified-dev hanya saat evidence source benar-benar ada di pushed dev SHA dan gate PR exact-SHA itu sukses.
3. Tautkan commit dan PR; bedakan in-main/released dari implementasi selesai.
4. Close issue hanya saat acceptance task terbukti; lifecycle release dicatat terpisah dan close tidak dipicu commit message otomatis.

### Verifikasi dan syarat selesai

Task code verified di dev tidak diklaim released; status tidak menyebut check hilang saat CI masih berjalan; gate PR exact-SHA harus berasal dari repository dan base branch yang diizinkan; task aktivasi remote tidak closed sebelum remote evidence.

Evaluator lokal memisahkan work status dari delivery stage, menolak status complete tanpa acceptance evidence dan source SHA penuh, mensyaratkan ancestry dev dan `ci-technical-gate` sukses pada head SHA dev terbaru, serta membedakan ancestry main dari tag GitHub Release yang memuat source. Collector memilih workflow CI event `pull_request` pada PR same-repository `dev` → `main`, memverifikasi nomor PR melalui REST API, serta memastikan head SHA sama dengan `origin/dev`, lalu membaca job `ci-technical-gate`; ia menunggu hasil terminal dengan batas waktu dan menolak fork, push, dispatch, base branch lain, atau SHA yang berbeda. Gate ini membuktikan seluruh lane teknis terpilih tanpa meminjam status persetujuan CODEOWNER; `ci-gate` tetap memblokir promosi sensitif. Snapshot juga memuat check exact-head bagi task terbuka yang source evidence-nya terbukti ancestor dev. Checkout full-history membuktikan ancestry; importer memvalidasi repository ID, exact plan SHA, freshness lima menit, coverage task index, dependency, dan status issue. Complete task dengan hard dependency belum selesai tetap tercatat sebagai complete namun membawa blocker dan tidak menjadi kandidat close, sehingga satu inkonsistensi dependency tidak menggagalkan seluruh snapshot. Plan summary menyebut close candidates dan manual-close triage. Manual apply memakai snapshot baru dan task IDs eksplisit maksimal lima; hanya menutup issue existing yang masih open ketika evaluator memberi `shouldClose`, dan re-read menolak race/perubahan manual. Test mencakup pemilihan run PR exact-SHA dan penolakan fork serta identitas base/repository yang salah, close kandidat terverifikasi, manual close setelah planning, serta adapter yang hanya mengirim `state: closed` pada operasi eksplisit. Hosted exact-source rerun read-only `37518455456` pada SHA `2012eaa4d49bad3a8bf41159bc12983956566800` sebelumnya sukses. Implementasi adapter dan gate workflow tersedia, tetapi exact-source hosted apply/recovery pilot tetap diperlukan sehingga M11.07 masih parsial.

Simpan bukti aktual di `docs/roadmap/evidence/M11.07.md`. Jangan menandai aktivasi selesai hanya karena YAML/script sudah ditulis. Saat task selesai, ikuti commit/push protocol; source status dan GitHub issue harus menyebut kondisi yang sama.

## M11.08 — Terima perubahan status dari maintainer tanpa memberikan eksekusi kode melalui issue.

- **Prasyarat:** M11.01, M11.05, M8.04.
- **Baca/periksa:** Issue events; actor permissions; bot identity.
- **Deliverable:** Trusted issue intake dan anti-loop tests.

### Langkah pelaksanaan

1. Proses hanya events managed issue dan aktor maintainer yang diverifikasi; ignore bot echoes.
2. Izinkan triage/assignee/blocked reason di Issues; perubahan acceptance/scope dibuat sebagai proposal diff untuk dev melalui writer coordinator.
3. Tolak command shell/ref/URL arbitrary dari issue text; close/reopen manual menjadi review request bila evidence belum cocok.

### Verifikasi dan syarat selesai

User tanpa write tidak dapat memicu push/publish; status update tidak menyebabkan infinite issue↔git loop.

Intake planner lokal pada `scripts/roadmap/issue-intake.mjs` hanya menghasilkan proposal. Adapter `scripts/roadmap/github-issue-intake.mjs` memvalidasi raw `issue_comment.created` payload, numeric repository ID dan repository full name, satu exact managed-task marker, comment/issue numeric identities, bot/PR exclusion, serta grammar `/mw status|scope|close|reopen -- <text>`. Sebelum proposal, adapter memeriksa permission aktor saat ini lewat GitHub collaborator-permission API; hanya `write`/`admin` diterima dan kegagalan lookup menolak event. Endpoint ini perlu `Metadata: read`, yang tidak tersedia sebagai scope eksplisit `GITHUB_TOKEN`; workflow meminta repository-scoped GitHub App token dengan permission minimum tersebut. Ia berhenti jelas bila variable `ROADMAP_INTAKE_APP_CLIENT_ID` atau secret `ROADMAP_INTAKE_APP_PRIVATE_KEY` belum tersedia. Workflow `.github/workflows/roadmap-issue-intake.yml` memakai checkout `github.sha` tanpa credential persistence dan tidak meminta write scope. `run-issue-intake.mjs` melaporkan metadata proposal ke Actions summary tanpa comment/rationale/body dan tanpa mutasi.

Sintaks yang dikenali (bukan berarti dieksekusi):

```text
/mw status blocked -- Menunggu review maintainer.
/mw scope -- Usulan perubahan batas acceptance.
/mw close -- Acceptance sudah dibuktikan; minta lifecycle review.
/mw reopen -- Bukti perlu diperiksa ulang.
```

Workflow ini baru ada di source `dev`; aktivasi hosted menunggu konfigurasi GitHub App, promosi ke `main`, retention Actions minimal tujuh hari yang dikonfirmasi admin, dan bukti run. Untuk redelivery, run name mengikat ID komentar dan step read-only memakai Actions run history sebagai ledger: hanya run sukses untuk komentar identik yang dilewati. Query `actions:read` dibatasi ke tujuh hari setelah pembuatan komentar, mengikuti pagination, dan fail-closed bila inventory berubah/tidak lengkap atau melampaui batas API. Event lebih lama dari tujuh hari ditolak agar tidak diproses tanpa bukti dedup yang memadai. Ini tidak menjanjikan exactly-once di luar jendela run history tersebut. Tidak ada issue event yang dapat menulis source atau mengubah issue.

Simpan bukti aktual di `docs/roadmap/evidence/M11.08.md`. Jangan menandai aktivasi selesai hanya karena YAML/script sudah ditulis. Saat task selesai, ikuti commit/push protocol; source status dan GitHub issue harus menyebut kondisi yang sama.

## M11.09 — Buat dashboard kemajuan dan GitHub Projects projection bila tersedia.

- **Prasyarat:** M11.04, M11.07, M0.04.
- **Baca/periksa:** Task/issue lifecycle; optional Projects API capabilities.
- **Deliverable:** Progress summary dan optional Projects sync.

### Langkah pelaksanaan

1. Bangun summary per milestone: todo/running/blocked/verified/main/released dengan source timestamp.
2. Jika Projects tersedia, petakan fields status/priority/lane/task ID dan upsert item per issue node ID.
3. Jika Projects unavailable, publish issue/dashboard summary setara; jangan membuat branch tambahan.
4. Tampilkan read-only summary pada GitHub Pages docs portal: work status dan delivery stage terpisah, exact source SHA/waktu terlihat, dan status delivery unknown tanpa snapshot lifecycle tepercaya.
5. Sertakan acceptance browser untuk deep link dalam Pages base path, provenance/status label, tabel semua milestone, keyboard semantics dan overflow mobile; jangan memasukkan issue body, komentar atau data privat ke bundle publik.

### Verifikasi dan syarat selesai

Progress tidak menghitung docs-only checklist centang sebagai released; project rerun tidak duplicate items.

Simpan bukti aktual di `docs/roadmap/evidence/M11.09.md`. Jangan menandai aktivasi selesai hanya karena YAML/script sudah ditulis. Saat task selesai, ikuti commit/push protocol; source status dan GitHub issue harus menyebut kondisi yang sama.

## M11.10 — Buat/perbarui PR dev → main otomatis dengan daftar task, hasil test, release plan dan risiko.

- **Prasyarat:** M1.05, M11.04, M7.06.
- **Baca/periksa:** Promotion PR workflow; managed issue map; prepared commit range.
- **Deliverable:** Promotion PR report renderer.

### Langkah pelaksanaan

1. Temukan satu PR dev→main; refresh generated summary dari source range dan task evidence.
2. Sertakan refs issue, perubahan version/changelog, checks, risk flags, upgrade notes dan incomplete tasks.
3. Jangan memakai Closes/Fixes untuk semua issues sekaligus; preserve reviewer/manual PR body sections.

### Verifikasi dan syarat selesai

Dua push memperbarui satu PR; incomplete issues tidak auto-close saat merge; source SHA perubahan tercatat.

Simpan bukti aktual di `docs/roadmap/evidence/M11.10.md`. Jangan menandai aktivasi selesai hanya karena YAML/script sudah ditulis. Saat task selesai, ikuti commit/push protocol; source status dan GitHub issue harus menyebut kondisi yang sama.

## M11.11 — Aktifkan auto-merge profesional dengan expected SHA, required checks dan review policy.

- **Prasyarat:** M1.06, M1.08, M11.10, M7.07.
- **Baca/periksa:** Repository auto-merge setting; PR checks/reviews; main rulesets.
- **Deliverable:** Auto-merge coordinator dan negative tests.

### Langkah pelaksanaan

1. Aktifkan auto-merge repo setelah checks/rulesets terbukti; gunakan merge commit, bukan admin bypass.
2. Periksa expected head SHA dan risk policy; jika head/diff berubah, evaluasi ulang dan disable queued auto-merge bila tidak lagi eligible.
3. Untuk PR sudah langsung mergeable, tetap verifikasi gate dan expected SHA; konflik/stale approval berarti menunggu, bukan memaksa merge.

### Verifikasi dan syarat selesai

Critical change tidak auto-merge tanpa review; new failed commit membatalkan eligibility; dev tidak dihapus setelah merge.

Simpan bukti aktual di `docs/roadmap/evidence/M11.11.md`. Jangan menandai aktivasi selesai hanya karena YAML/script sudah ditulis. Saat task selesai, ikuti commit/push protocol; source status dan GitHub issue harus menyebut kondisi yang sama.

## M11.12 — Terapkan aturan commit dan push per unit pekerjaan yang selesai.

- **Prasyarat:** M1.01, M2.02.
- **Baca/periksa:** EXECUTION.md; git status/diff; root verification scripts.
- **Deliverable:** Delivery protocol dan handoff fields.

### Langkah pelaksanaan

1. Agen yang selesai satu unit logis menjalankan checks relevan, menulis evidence, lalu stage hanya file task yang diperiksa.
2. Commit Conventional Commit berisi task ID dan issue Ref bila tersedia; push ke dev normal lalu cek remote SHA.
3. No-op tidak membuat empty commit; gagal push dicatat sebagai not-delivered dan ditangani tanpa force; main hanya melalui promotion.

### Verifikasi dan syarat selesai

Completed unit memiliki local/remote SHA sama; untracked file pengguna tidak ikut staged; failure tidak diklaim delivered.

Simpan bukti aktual di `docs/roadmap/evidence/M11.12.md`. Jangan menandai aktivasi selesai hanya karena YAML/script sudah ditulis. Saat task selesai, ikuti commit/push protocol; source status dan GitHub issue harus menyebut kondisi yang sama.

## M11.13 — Gabungkan commit/push, version bump, docs dan issue sync tanpa release loop.

- **Prasyarat:** M11.06, M11.12, M7.04, M7.15.
- **Baca/periksa:** Release classifier; issue sync events; generator writes.
- **Deliverable:** Unified event graph dan loop regression tests.

### Langkah pelaksanaan

1. Pisahkan substantive code commits dari docs/status/sync/generated changes memakai provenance tervalidasi.
2. Satu batch release menghitung version dari last release dan substantive commits; setiap task tetap committed tetapi bukan berarti setiap commit membuat release.
3. Generated issue mapping/lifecycle tidak ditulis bolak-balik ke git setiap status berubah; simpan remote projection dan source evidence minimal.

### Verifikasi dan syarat selesai

Status-only push tidak bump; retry prepare tidak bump lagi; satu code change menghasilkan satu stable version per promotion batch.

Regression integration fixture pada `scripts/release-loop.test.mjs` merangkai classifier/planner dan preparer: satu feature commit menghasilkan satu RC candidate; docs/status commits dan `chore(release)` preparation commit tidak mengubah candidate; rerun pada manifests/CHANGELOG hasil prepare menjadi `already-prepared` tanpa file write. Workflow issue plan hanya memiliki read permission untuk repo content dan issue apply mengubah Issues saja; tidak ada issue mapping/status commit kembali ke Git. Hosted release preparation masih menunggu workflow default-branch/auth gate M7.05 sehingga M11.13 tetap parsial.

Simpan bukti aktual di `docs/roadmap/evidence/M11.13.md`. Jangan menandai aktivasi selesai hanya karena YAML/script sudah ditulis. Saat task selesai, ikuti commit/push protocol; source status dan GitHub issue harus menyebut kondisi yang sama.

## M11.14 — Uji seluruh siklus roadmap → issue → commit → CI → PR → merge → release → status.

- **Prasyarat:** M11.07, M11.08, M11.11, M11.13, M7.14.
- **Baca/periksa:** Fake GitHub adapter; workflow fixtures; task evidence fixtures.
- **Deliverable:** Issue/PR lifecycle fault-injection report.

### Langkah pelaksanaan

1. Uji initial import, task update, manual notes, renamed task title, deleted task, duplicate marker dan API timeout.
2. Uji CI fail, stale head, blocked dependency, manual close tanpa evidence, permission revoked dan out-of-order events.
3. Lakukan dry-run terhadap repo read-only, lalu satu task pilot nyata sebelum bulk import setelah activation diotorisasi.

### Verifikasi dan syarat selesai

Semua event idempotent; no premature close/version; expected one issue/task dan one promotion PR; no third branch.

Regression fixtures yang sudah berjalan menguji initial plan/no-op, update dengan catatan manusia yang berubah serentak, perubahan managed content yang menolak PATCH, stale input plan, duplicate marker, write permission dicabut sebelum metadata/update, create timeout yang pulih hanya setelah marker ditemukan, serta kegagalan create tanpa blind retry. Lifecycle fixtures menolak snapshot basi/salah SHA, required checks pada SHA lain atau gagal, dependency belum selesai, dan manual close tanpa evidence. Ini menyelesaikan fault tests lokal untuk issue projection saja; simulasi out-of-order hosted events, auth nyata, CI→PR→merge→release satu siklus dan task pilot tetap bergantung pada M11.07/M11.08/M11.11/M7.14 dan aktivasi GitHub.

M11.05 follow-up: reconciliation tidak lagi memangkas whitespace pada prefix/suffix body di luar managed markers. Test membandingkan isi di kedua sisi byte-for-byte setelah update; issue legacy yang sudah memiliki identity marker tetapi belum memiliki generated block tetap mempertahankan diskusinya persis ketika block ditambahkan.

Simpan bukti aktual di `docs/roadmap/evidence/M11.14.md`. Jangan menandai aktivasi selesai hanya karena YAML/script sudah ditulis. Saat task selesai, ikuti commit/push protocol; source status dan GitHub issue harus menyebut kondisi yang sama.

## M11.15 — Sediakan runbook audit/recovery dan pemeriksaan drift issue/roadmap.

- **Prasyarat:** M11.14, M8.09.
- **Baca/periksa:** Managed issues; tasks index; lifecycle evidence.
- **Deliverable:** docs/operations/roadmap-sync.md dan recurring audit.

### Langkah pelaksanaan

1. Audit missing/duplicate/orphan issues, invalid labels, stale milestone dan dead links.
2. Task dihapus dari source tidak otomatis dihapus dari GitHub; tandai needs-triage dengan penjelasan.
3. Sediakan rebuild projection/dry-run/resume commands dan laporan ringkas tanpa spam; manual override punya alasan/expiry.

### Verifikasi dan syarat selesai

Recovery import menjaga diskusi; stale roadmap projection terdeteksi; unresolved conflict tetap terlihat.

Implementasi parsial: `scripts/roadmap/audit-issues.mjs` membaca semua managed issue open/closed, membandingkan marker ID, source SHA, milestone, managed labels, dan Card/Evidence target tanpa mengambil URL arbitrer atau mencetak body/notes. Ia juga membandingkan state issue dengan status source task dan proyeksi lifecycle di dalam blok terkelola (`lifecycleStateDrift`): terbuka padahal complete+terkirim tanpa blocker, atau tertutup padahal source belum complete. Claim itu butuh status source, sehingga blok projection yang basi tidak bisa menghasilkan drift palsu. Ia melaporkan orphan sebagai `needs-triage` rekomendasi tanpa write. `Roadmap issue sync` memanggil audit read-only sebelum planner dan menghapus JSON ephemeral melalui EXIT trap; `docs/operations/roadmap-sync.md` berisi interpretasi drift dan bounded recovery. Hosted audit/pagination/failure recovery serta M11.14 write/fault pilot belum dibuktikan, maka M11.15 tetap terbuka.

Simpan bukti aktual di `docs/roadmap/evidence/M11.15.md`. Jangan menandai aktivasi selesai hanya karena YAML/script sudah ditulis. Saat task selesai, ikuti commit/push protocol; source status dan GitHub issue harus menyebut kondisi yang sama.
