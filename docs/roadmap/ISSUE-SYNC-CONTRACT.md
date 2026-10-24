# Kontrak roadmap, Issues, PR dan delivery

## Tujuan dan batas aktivasi

Setiap task roadmap mempunyai satu issue GitHub yang dapat ditelusuri ke source, bukti, commit, CI, PR, dan release. Push `dev` otomatis merekonsiliasi hanya task yang isi checklist, index, kartu, atau evidence berubah. Apply dibatasi lima task per run, menghitung ulang state remote sebelum menulis, dan tetap terpisah dari auto-merge/release. Backfill issue lama memerlukan pilihan ID eksplisit; perubahan besar yang melewati batas harus dipecah menjadi batch terkontrol.

Source code tetap menggunakan hanya `main` dan `dev`. Tidak membuat issue branches, dependency branches, release branches, maupun `gh-pages`.

## Otoritas data

| Data                                       | Pemilik kebenaran                                   | Arah sinkronisasi                                            |
| ------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------ |
| Task ID, scope, acceptance, dependencies   | Git pada dev, setelah perubahan source tervalidasi  | Git → generated issue block                                  |
| Task completion                            | ROADMAP.md dengan evidence yang sesuai              | Git/evidence → issue lifecycle                               |
| Assignee, triage, blocked reason, diskusi  | GitHub Issues, oleh maintainer berwenang            | Diproyeksikan ke dashboard; tidak menulis ulang code         |
| Source SHA, pushed SHA, run/check outcomes | Git dan GitHub run metadata                         | Sistem → issue evidence summary                              |
| Promoted/released                          | Verified main SHA dan release manifest              | Sistem → lifecycle labels/dashboard                          |
| Perubahan scope dari issue                 | Proposal maintainer, belum accepted source          | Validated proposal → dev melalui coordinator → full sync     |
| Manual close/reopen                        | Intent maintainer; tidak otomatis mengubah evidence | Reconcile/report; cek acceptance sebelum accepted completion |

Tujuannya bukan blind two-way sync. Generated fields dan human fields memiliki pemilik jelas sehingga bot tidak terus mengembalikan perubahan manusia atau mencentang task yang belum dikerjakan.

## Identitas dan generated body

Identitas stabil menggunakan repository ID plus task ID. Title dapat berubah, nomor issue tidak diketahui sebelum create. Lookup managed issues harus membaca pagination open+closed dan mengabaikan pull requests yang ikut muncul pada Issues REST API.

Contoh body target:

```markdown
<!-- moonwitness-task: <numeric-repository-id>:M11.03 -->
<!-- BEGIN MOONWITNESS MANAGED -->

Task: M11.03
Milestone: M11
Source: <link ke kartu pada exact source SHA>
Dependencies: <links ke prerequisite issues>

## Tujuan

<title dan expected deliverable>

## Langkah

<langkah dari kartu>

## Acceptance

<kriteria yang benar-benar diuji>

## Evidence dan delivery

<link evidence, commit, CI, PR, release jika tersedia>
<!-- END MOONWITNESS MANAGED -->

## Catatan maintainer

<bagian ini tidak ditimpa bot>
```

- Jangan memasukkan waktu run setiap kali ke body jika substansi tidak berubah; itu menimbulkan update dan notifikasi sia-sia.
- Gunakan normalized content hash untuk membandingkan generated content; jangan menjadikan title sebagai unique key.
- Jika beberapa issues memiliki marker sama, laporkan duplicate dan minta triage; jangan menghapus diskusi otomatis.
- Jika source task dihapus, tandai orphan/needs-triage; jangan delete issue.
- Label managed memakai namespace, misalnya `roadmap`, `lane:automation`, `priority:p1`, `stage:verified-dev`. Label manusia di luar namespace dipertahankan.
- Sebelum menambahkan assignee atau Project, verifikasi akun/akses; unsupported field tidak boleh memblokir core issue sync.

## Lifecycle task berbeda dari lifecycle release

| Stage        | Syarat                                              | Issue state default                                      |
| ------------ | --------------------------------------------------- | -------------------------------------------------------- |
| planned      | Kartu ada dan tervalidasi                           | Open                                                     |
| ready        | Prasyarat acceptance sudah terbukti                 | Open                                                     |
| in-progress  | Pelaksana menyatakan sedang bekerja                 | Open                                                     |
| blocked      | Alasan dan dependency konkret tercatat              | Open                                                     |
| verified-dev | Implementasi, relevant checks dan push dev terbukti | Open jika acceptance masih membutuhkan main/remote       |
| complete     | Seluruh acceptance kartu terpenuhi                  | Closed dengan evidence                                   |
| in-main      | SHA perubahan sudah masuk main                      | Label/delivery field, bukan asumsi completion            |
| released     | Manifest release membuktikan perubahan terpublikasi | Label/delivery field; tidak wajib untuk setiap task docs |

Implementation status dan delivery stage adalah dua dimensi. Task audit read-only dapat complete tanpa app release; task Pages activation tidak complete hanya karena tests lokal sukses. Closed tidak selalu released.

Manual close tanpa evidence menimbulkan `needs-triage` dan report. Jangan membuat perang reopen/close otomatis; perubahan source/status hanya diterima setelah maintainer dan evidence direkonsiliasi. Event tidak tepercaya tidak boleh memicu commit, shell command, release, atau arbitrary URL fetch.

Evaluator lokal di `scripts/roadmap/lifecycle.mjs` hanya memproyeksikan fakta terstruktur yang diberikan pemanggil: source ancestry, required check runs pada SHA dev saat ini, ancestry main, dan manifest release. Collector `scripts/roadmap/collect-lifecycle-snapshot-cli.mjs` membaca `ci-technical-gate` dari run `ci.yml` untuk PR same-repository `dev` → `main` dengan exact dev SHA dan GitHub Releases via `gh`, lalu memakai full checkout untuk membuktikan ancestry source/dev/main/tag; status kerja dan acceptance berasal dari checkbox tervalidasi serta evidence file. Pengumpulan gate tidak menunggu hosted CI: ia membaca sekali status run/job exact SHA. Gate pending atau belum tersedia tetap tidak terverifikasi, sehingga issue metadata dapat disinkronkan tanpa menjadikan issue kandidat close; sinkronisasi berikutnya mengambil hasil terminal terbaru. Gate hanya sukses bila plan dan seluruh lane terpilih sukses; `ci-gate` tetap menjadi status check promosi sesuai kebijakan M1.02–M1.06 dan dapat menunggu CODEOWNER. Source SHA yang tidak ditemukan di evidence tidak dipinjam dari evidence commit; task tetap complete secara kerja tetapi delivery tidak diverifikasi dan issue tidak menjadi kandidat close. Importer `scripts/roadmap/lifecycle-snapshot.mjs` menolak repo/SHA yang berbeda, snapshot lebih tua dari lima menit, task hilang/duplikat/tidak dikenal. Hard dependency yang belum complete dipertahankan sebagai blocker dan mencegah issue close, termasuk jika acceptance checkbox task sudah dicentang. Planner default tetap read-only dengan `--lifecycle-snapshot <path>`. Apply hanya pada manual dispatch dev, task IDs eksplisit (maksimal lima), fresh snapshot exact SHA, fresh remote re-plan, permission `issues: write`, dan writer coordinator. Reconciler hanya menutup issue yang sudah ada dan masih open bila snapshot membuktikan acceptance, dependency dan `verified-dev`/delivery criteria; closed manual tetap closed dan race perubahan state menggagalkan PATCH. Snapshot ephemeral dihapus setelah dipakai. Hosted lifecycle write pilot masih harus dibuktikan sebelum M11.07 ditutup.

## Commit/push yang wajib pada setiap unit selesai

1. Selesaikan satu perubahan logis beserta acceptance relevan.
2. Periksa `git status` dan `git diff`; stage hanya path yang diketahui milik task.
3. Tambahkan evidence/handoff; jangan mengikutsertakan .env, credentials, browser state atau unrelated user changes.
4. Commit memakai Conventional Commit dengan ID task, contoh `feat(ui): add accessible field primitive (M5.10)`.
5. Jika issue sudah ada, gunakan `Refs #123` dalam body. Jangan memakai `Closes` secara default.
6. Push ke `dev` tanpa force dan verifikasi remote head mengandung commit hasil pekerjaan.
7. Jalankan/periksa CI untuk source SHA itu bila workflow telah aktif; laporkan pushed, CI pending, CI failed atau verified sesuai hasil sebenarnya.
8. Main berubah melalui promotion PR; tidak push langsung ke main untuk menghindari checks.

Commit/push bukan berarti commit setiap tool call. Unit selesai adalah perubahan coherent yang bisa direview. Jika tak ada perubahan, no-op tanpa empty commit. Jika task berhenti saat WIP, simpan status dan handoff; jangan mengklaim selesai atau memasukkan kode rusak sebagai completed task. Konflik remote ditangani dengan integrasi perubahan normal, bukan reset/force.

## Auto-PR dan auto-merge

- Satu PR aktif `dev → main` untuk promotion batch; update body managed berdasarkan current dev head.
- Body memuat task IDs/issue refs, testing, risks, version plan dan perubahan upgrade notes.
- Jangan otomatis menutup semua issues yang direferensikan PR. Penutupan issue mengikuti acceptance, bukan sekadar PR merged.
- Aktifkan repository auto-merge hanya setelah branch rules/checks berjalan dan semantik review ditetapkan.
- Auto-merge eligible hanya untuk trusted dev source, exact latest head, all required checks, risk classification dan review policy yang terpenuhi.
- Gunakan merge commit dan pertahankan dev. Tidak menggunakan admin override untuk memaksa merge.
- Jika head berubah, eligibility dan approval dievaluasi ulang. Check hijau pada SHA lama tidak cukup.
- Merge queue bukan prasyarat; jangan mengaktifkan fitur yang membutuhkan branch sementara atau account capability tanpa mengevaluasi kompatibilitas two-branch policy.

GitHub menutup linked issue dengan closing keywords ketika perubahan masuk default branch. Karena acceptance beberapa task baru terbukti setelah publish, gunakan references biasa sampai reconciler memiliki bukti yang sesuai. [Dokumentasi issue linking](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue).

Auto-merge GitHub menunggu required checks dan reviews; setting repository dan eligibility PR tetap harus disiapkan. [Dokumentasi auto-merge](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/automatically-merging-a-pull-request).

## Hubungan dengan version bump

- Setiap unit selesai di-commit/push; tidak berarti setiap unit menghasilkan versi aplikasi baru.
- Release planner mengelompokkan substantive changes sejak release terakhir menjadi satu next version.
- Documentation-only, roadmap state, issue sync, generated mapping dan bot housekeeping tidak memicu app version bump sendiri.
- Prepared release commit tidak menyebabkan planner menaikkan versi lagi.
- Re-run release/issue sync harus no-op ketika input sama.
- Issue status update tidak boleh memicu git commit lalu issue update tanpa akhir. Jangan commit mapping issue/status setiap kali sinkronisasi jika remote marker cukup sebagai identity.
- Main stable release hanya dari verified SHA; updater/readme bot tidak boleh publish code yang belum melalui gate.

## Workflow target dan bootstrap

1. Validator lokal memeriksa index/cards/dependencies dan menghasilkan desired issues.
2. Dry-run membaca seluruh remote managed issues dan menulis plan create/update/no-op/conflict. Pada repository publik, planning read-only tidak memerlukan token; private repositories tetap memerlukan credential read yang sesuai.
3. Push `dev` membandingkan checklist, objek task index, seksi kartu, dan evidence antara `before` dan `head`; hanya Task ID yang berubah dikirim ke bounded apply.
4. Apply membaca ulang semua issue open/closed, menolak fingerprint basi/konflik, memastikan metadata milestone/label, kemudian menulis serial dengan recovery marker dan maksimal lima task.
5. Backfill otomatis memilih maksimal lima operasi create/update berikutnya per hari dari plan pada SHA `dev` terbaru. Job terjadwal berjalan dari workflow `main` tetapi checkout dan guard apply wajib membuktikan SHA `dev` masih sama dengan plan; manual dispatch tetap menyediakan Task ID eksplisit atau pilihan next batch.
6. Tambahkan lifecycle updates dari CI/promosi/release dengan source SHA validation.
7. Aktifkan dashboard/Projects projection hanya setelah core sync stabil.

Current default branch masih main. Scheduled/manual workflow discovery dan GitHub App setup harus diuji saat bootstrap; workflow yang hanya ada di dev mungkin belum menjadi entry point schedule/manual sebagaimana diharapkan. Promosikan workflow lewat jalur terverifikasi sebelum mengklaim schedule aktif.

GitHub API mutations dilakukan serial dan menghormati Retry-After/rate reset. Automatic push sync hanya menerapkan task yang berubah pada exact push; job backlog terjadwal membuat/memperbarui paling banyak lima task per hari sampai seluruh projection sinkron. Keduanya menggunakan exact SHA dan shared writer coordinator. Jalur kerja agen boleh paralel, API writes tetap terkoordinasi. [Best practices GitHub REST API](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api).

## Test wajib untuk reconciler

| Skenario                                           | Expected                                          |
| -------------------------------------------------- | ------------------------------------------------- |
| Task baru                                          | Satu managed issue dibuat                         |
| Run input identik                                  | No create/update/comment                          |
| Judul task berubah                                 | Issue yang sama diperbarui                        |
| API create sukses tetapi response timeout          | Re-read identity menemukan issue; tidak duplicate |
| Lebih dari satu halaman issues                     | Seluruh managed issues ditemukan                  |
| Duplicate marker                                   | Conflict report; tidak delete otomatis            |
| Human notes berubah                                | Notes dipertahankan                               |
| Markers body rusak                                 | Fail aman; tidak overwrite                        |
| Git acceptance belum selesai, issue ditutup manual | Needs-triage; roadmap tidak dicentang otomatis    |
| Source task dihapus                                | Orphan triage; issue/discussion tetap ada         |
| CI gagal pada SHA terbaru                          | Tidak verified/complete karena old green run      |
| PR referensi 10 tasks, 3 belum selesai             | Tiga task tetap open                              |
| Event bot dipantulkan kembali                      | Ignore/no-op; tidak loop                          |
| Actor tanpa permission mengirim perintah           | Tidak ada git/release mutation                    |
| 429/secondary limit                                | Backoff terukur dan resumable                     |
| Credential dicabut                                 | Blocked setup, bukan success palsu                |
| Dev berubah sebelum push generator                 | Recompute; tidak overwrite                        |
| Docs-only status commit                            | No application version bump                       |
| Retry release yang sudah published                 | Same version/assets; status direkonsiliasi        |
