# M7 — Kartu kerja terperinci

Baca [protokol eksekusi](EXECUTION.md) terlebih dahulu. Status resmi tetap di [master checklist](../../ROADMAP.md); dokumen ini menjelaskan pekerjaan, bukan bukti bahwa fitur sudah ada. Path output yang belum ada adalah usulan deliverable. Semua path kode relatif terhadap root repository.

## M7.01 — Terapkan Conventional Commits dan definisi patch/minor/major/non-release secara konsisten.

- **Prasyarat:** M0.07
- **Baca/periksa:** Commit history; CHANGELOG.md; check-release.mjs.
- **Deliverable:** Release classification module/tests.

### Langkah pelaksanaan

1. Definisikan allowed commit types/scope dan parser untuk !/BREAKING CHANGE trailers.
2. Tentukan cara membaca merge commits dan source commits tanpa double count.
3. Validasi release-worthy vs non-release dengan table tests.

### Verifikasi dan syarat selesai

fix→patch, feat→minor, breaking→major, docs/chore-only→none; merge duplicate tidak menaikkan dua kali.

Catat command/test case, actual result, SHA sumber dan lokasi bukti dalam `docs/roadmap/evidence/M7.01.md` sesuai template. Jika kemampuan eksternal belum tersedia, pisahkan implementasi lokal yang selesai dari aktivasi yang terblokir; jangan centang item penuh. Jangan menonaktifkan check yang gagal agar item dianggap selesai.

## M7.02 — Tetapkan satu versi monorepo bersama; sinkronkan root/workspaces/lockfile/metadata yang relevan.

- **Prasyarat:** M7.01
- **Baca/periksa:** Root/workspace versions; lockfile; private flags.
- **Deliverable:** Version updater dan consistency tests.

### Langkah pelaksanaan

1. Tentukan workspace mana ikut shared product version termasuk API/Board.
2. Update version fields dan internal spec hanya yang memerlukan perubahan; gunakan package manager untuk lockfile.
3. Validasi tidak mengubah private package menjadi npm-public.

### Verifikasi dan syarat selesai

Semua scoped versions konsisten; frozen install dan release check pass.

Catat command/test case, actual result, SHA sumber dan lokasi bukti dalam `docs/roadmap/evidence/M7.02.md` sesuai template. Jika kemampuan eksternal belum tersedia, pisahkan implementasi lokal yang selesai dari aktivasi yang terblokir; jangan centang item penuh. Jangan menonaktifkan check yang gagal agar item dianggap selesai.

## M7.03 — Putuskan transisi `1.0.0-rc.1` ke stable secara eksplisit; jangan auto-publish stable hanya karena automation baru aktif.

- **Prasyarat:** M0.04, M7.01
- **Baca/periksa:** Existing tags/releases; current 1.0.0-rc.1.
- **Deliverable:** First stable release decision record.

### Langkah pelaksanaan

1. Inventarisasi tags aktual dan hubungan SHA tanpa mengubah existing tag.
2. Tetapkan state prerelease/stable dan explicit first-stable decision dalam config.
3. Dry-run kedua jalur; tag prerelease tidak mengubah stable latest.

### Verifikasi dan syarat selesai

Tidak ada stable publish otomatis saat bootstrap; expected next version dinyatakan dalam release plan.

Catat command/test case, actual result, SHA sumber dan lokasi bukti dalam `docs/roadmap/evidence/M7.03.md` sesuai template. Jika kemampuan eksternal belum tersedia, pisahkan implementasi lokal yang selesai dari aktivasi yang terblokir; jangan centang item penuh. Jangan menonaktifkan check yang gagal agar item dianggap selesai.

## M7.04 — Hitung versi dari release terakhir dan perubahan fungsional; abaikan commit generator/sync untuk mencegah release loop.

- **Prasyarat:** M7.01, M7.03
- **Baca/periksa:** Git history dan release manifest.
- **Deliverable:** Deterministic release planner.

### Langkah pelaksanaan

1. Ambil last published release sebagai baseline dan simpan base/head SHAs.
2. Hitung next version dari substantive commits, bukan current generated version semata.
3. Kecualikan automation commits dengan provenance/known operation, bukan menerima semua message prefix spoofed.

### Verifikasi dan syarat selesai

Prepare ulang sebelum release tidak bump dua kali; no releasable change menghasilkan no-op.

Catat command/test case, actual result, SHA sumber dan lokasi bukti dalam `docs/roadmap/evidence/M7.04.md` sesuai template. Jika kemampuan eksternal belum tersedia, pisahkan implementasi lokal yang selesai dari aktivasi yang terblokir; jangan centang item penuh. Jangan menonaktifkan check yang gagal agar item dianggap selesai.

Planner read-only tersedia melalui `pnpm release:plan`; output JSON menyertakan tag/SHA baseline, head SHA, klasifikasi, next prerelease version, commit yang dihitung/diabaikan, serta status `no-release` atau `invalid`. Planner default tidak membuat tag dan selalu menghasilkan kandidat `-rc.1`; keputusan mengaktifkan stable tetap menunggu M7.03. Tag/SHA baseline dapat dipilih secara eksplisit untuk reproduksi.

## M7.05 — Siapkan version/changelog/docs pada dev tanpa release branch; persiapan berulang harus idempotent.

- **Prasyarat:** M7.02, M7.04, M6.04, M7.08
- **Baca/periksa:** Dev head; version updater; changelog/docs generator.
- **Deliverable:** Prepare-release automation.

### Langkah pelaksanaan

1. Jalankan planner, preparation preview, dan dry-run read-only langsung di `dev`; jangan membuat branch/checkout sementara.
2. Pastikan input head dan fingerprint sama pada kedua preview, lalu review daftar file, aset, gate, dan seluruh side-effect flag.
3. Terapkan perubahan hanya melalui jalur release yang memang diotorisasi; jangan menganggap preview kandidat sebagai perubahan versi yang telah disetujui.
4. Catat input head, fingerprint, hasil pemeriksaan, serta hosted acceptance yang masih terbuka. Commit/push batch roadmap atau implementasi lokal ke `dev` sesuai aturan kerja.

### Verifikasi dan syarat selesai

Retry menghasilkan no diff; perubahan pengguna pada dev menyebabkan recompute bukan overwrite.

Catat command/test case, actual result, SHA sumber dan lokasi bukti dalam `docs/roadmap/evidence/M7.05.md` sesuai template. Jika kemampuan eksternal belum tersedia, pisahkan implementasi lokal yang selesai dari aktivasi yang terblokir; jangan centang item penuh. Jangan menonaktifkan check yang gagal agar item dianggap selesai.

## M7.06 — Changelog berisi fitur/fix/security/breaking/upgrade dan tautan commit/PR; breaking notes divalidasi.

- **Prasyarat:** M7.04
- **Baca/periksa:** Commit metadata; docs upgrade notes.
- **Deliverable:** Changelog generator/templates/tests.

### Langkah pelaksanaan

1. Render changelog section dengan features/fixes/security/breaking/upgrade.
2. Sertakan PR/commit links yang valid; jangan memasukkan raw secret/vulnerability detail yang belum boleh publik.
3. Wajibkan upgrade text untuk breaking/schema behavior changes.

### Verifikasi dan syarat selesai

Missing breaking guide memblokir promotion; generated section tidak duplikat.

Catat command/test case, actual result, SHA sumber dan lokasi bukti dalam `docs/roadmap/evidence/M7.06.md` sesuai template. Jika kemampuan eksternal belum tersedia, pisahkan implementasi lokal yang selesai dari aktivasi yang terblokir; jangan centang item penuh. Jangan menonaktifkan check yang gagal agar item dianggap selesai.

Renderer read-only menerima file output `release:plan` dan tanggal eksplisit: `pnpm release:changelog <plan.json> <YYYY-MM-DD>`. Hasil ditulis ke stdout agar release preparation dapat meninjau diff sebelum memasukkan ke `CHANGELOG.md`. Commit PR bertaut ke `/pull/<number>` hanya jika subject memakai akhiran Conventional `(#number)`; commit selalu ditautkan ke SHA. Breaking commit memerlukan trailer `UPGRADE:` yang berisi langkah konkret. Detail commit keamanan diringkas menjadi label umum; body commit selain trailer upgrade tidak disalin ke changelog.

## M7.07 — Jalankan CI lengkap pada commit hasil persiapan; verifikasi lagi main merge SHA sebelum publikasi.

Release workflow pada tag memeriksa ancestor `main` dan `ci-gate` sukses pada run `push` di exact source SHA. Bukti unit ada di [M7.07](evidence/M7.07.md); hosted dispatch dan publication belum diverifikasi.

- **Prasyarat:** M2.05
- **Baca/periksa:** Prepared dev SHA; PR merge SHA; ci-gate.
- **Deliverable:** Verified source gate.

### Langkah pelaksanaan

1. Jalankan full suite pada prepared dev head dan invalidate hasil ketika head berubah.
2. Setelah merge, verifikasi main merge commit dengan workflow trusted.
3. Publikasi hanya menerima exact SHA dan successful verification identity.

### Verifikasi dan syarat selesai

Input SHA yang bukan verified commit ditolak walau branch punya run hijau lain.

Catat command/test case, actual result, SHA sumber dan lokasi bukti dalam `docs/roadmap/evidence/M7.07.md` sesuai template. Jika kemampuan eksternal belum tersedia, pisahkan implementasi lokal yang selesai dari aktivasi yang terblokir; jangan centang item penuh. Jangan menonaktifkan check yang gagal agar item dianggap selesai.

## M7.08 — Gunakan concurrency lock dan pengecekan expected SHA sebelum bot menulis; perubahan dev baru membatalkan rencana lama.

- **Prasyarat:** M2.09, M8.04
- **Baca/periksa:** All automation writes; GitHub concurrency; expected head.
- **Deliverable:** Write coordination dan race fixture.

### Langkah pelaksanaan

1. Serialkan prepare/dependency/docs writer melalui satu write coordinator atau shared lock.
2. Baca head setelah lock diperoleh; push tanpa force dan tangani rejected push.
3. Jika source bergerak sebelum publish, jangan mengganti artefak/tag yang sedang diselesaikan; antre release berikutnya.

### Verifikasi dan syarat selesai

Concurrent dependency dan release runs mempertahankan semua substantive changes.

Catat command/test case, actual result, SHA sumber dan lokasi bukti dalam `docs/roadmap/evidence/M7.08.md` sesuai template. Jika kemampuan eksternal belum tersedia, pisahkan implementasi lokal yang selesai dari aktivasi yang terblokir; jangan centang item penuh. Jangan menonaktifkan check yang gagal agar item dianggap selesai.

## M7.09 — Bangun sekali artefak release dari SHA tervalidasi lalu promosikan artefak yang sama; jangan rebuild tanpa verifikasi identitas.

Image artifact handoff, source labels, same-image smoke/CRITICAL scan, dan publish tanpa rebuild sudah dikontrak di [M7.09](evidence/M7.09.md). Hosted artifact digest equality/push verification tetap acceptance work.

- **Prasyarat:** M7.07, M4.13
- **Baca/periksa:** Dockerfile; build outputs; verification jobs.
- **Deliverable:** Build-once artifact flow.

### Langkah pelaksanaan

1. Build release candidates dari main SHA terverifikasi, simpan image/artifact digest.
2. Jalankan image smoke/security checks pada candidates yang sama.
3. Promosikan digest yang diperiksa ke tags versi; hindari second build di publish step.

### Verifikasi dan syarat selesai

Digest yang dicatat pada test sama dengan yang dirilis; source revision label tepat.

Catat command/test case, actual result, SHA sumber dan lokasi bukti dalam `docs/roadmap/evidence/M7.09.md` sesuai template. Jika kemampuan eksternal belum tersedia, pisahkan implementasi lokal yang selesai dari aktivasi yang terblokir; jangan centang item penuh. Jangan menonaktifkan check yang gagal agar item dianggap selesai.

## M7.10 — Buat tag immutable, draft/release completion flow, changelog, checksums, GHCR API/Board, SBOM dan provenance attestations.

Workflow lokal kini membangun SPDX SBOM untuk kedua image, membuat checksums bundle dan asset, membuat artifact + OCI image provenance/SBOM attestations, menahan GitHub Release sebagai draft sampai assets cocok dengan nama/digest/ukuran yang diharapkan, lalu verifikasi asset sebelum publish. Implementasi kontrak telah dites lokal; full hosted GHCR/GitHub Release run masih acceptance wajib. Lihat [runbook release artifact](../operations/release-artifact-flow.md).

- **Prasyarat:** M7.09, M7.06, M8.01
- **Baca/periksa:** Release candidate manifest; GHCR; GITHUB_TOKEN/App permissions.
- **Deliverable:** Release manifest, draft flow dan publishing jobs.

### Langkah pelaksanaan

1. Buat draft release dengan planned required assets dan immutable source tag.
2. Upload checksums/SBOM/provenance dan API/Board candidates; verify asset presence/digest.
3. Mark release complete/published setelah seluruh wajib ada; jangan menjalankan app deploy.

### Verifikasi dan syarat selesai

Partial upload tidak menjadi completed release; assets punya source SHA dan digest.

Catat command/test case, actual result, SHA sumber dan lokasi bukti dalam `docs/roadmap/evidence/M7.10.md` sesuai template. Jika kemampuan eksternal belum tersedia, pisahkan implementasi lokal yang selesai dari aktivasi yang terblokir; jangan centang item penuh. Jangan menonaktifkan check yang gagal agar item dianggap selesai.

## M7.11 — Tag image memakai versi/SHA; update latest hanya setelah seluruh artefak wajib berhasil. Tidak deploy aplikasi.

Stable `latest` hanya dimajukan bila tag candidate secara semver lebih baru dari stable GitHub Release lain yang sudah dipublikasikan. Retry untuk tag candidate yang sama tetap menerapkan ulang alias dengan digest yang sama; prerelease dan kandidat lebih lama tidak menurunkan alias. Detail dan hasil test ada di [M7.11](evidence/M7.11.md). Hosted release masih perlu membuktikan policy berjalan dengan token repository.

- **Prasyarat:** M7.10
- **Baca/periksa:** Candidate digests; semver/prerelease state.
- **Deliverable:** Registry promotion policy dan tests.

### Langkah pelaksanaan

1. Tag image dengan product version dan commit SHA secara konsisten.
2. Update stable latest hanya untuk version lebih baru setelah required assets complete.
3. Jika satu latest pointer gagal diperbarui, simpan status partial dan retry tanpa rebuild atau rollback tag immutable.

### Verifikasi dan syarat selesai

Retry older release tidak menurunkan latest; prerelease tidak mengganti stable latest.

Catat command/test case, actual result, SHA sumber dan lokasi bukti dalam `docs/roadmap/evidence/M7.11.md` sesuai template. Jika kemampuan eksternal belum tersedia, pisahkan implementasi lokal yang selesai dari aktivasi yang terblokir; jangan centang item penuh. Jangan menonaktifkan check yang gagal agar item dianggap selesai.

## M7.12 — Verifikasi provenance/digest dan dokumentasikan cara konsumen memeriksanya.

CLI `pnpm release:verify-attestations` memeriksa checksum, source SHA dan version, lalu memverifikasi bundle/SBOM/image attestations dengan repository dan signer workflow yang eksplisit. Fixture lokal menolak data terubah serta workflow repository salah. Hosted attestation identity/digest belum dibuktikan sampai release workflow dijalankan di GitHub; lihat [consumer verification runbook](../operations/release-artifact-flow.md#consumer-verification).

- **Prasyarat:** M7.10
- **Baca/periksa:** Attestation outputs; checksums; docs release guide.
- **Deliverable:** Provenance verification instructions.

### Langkah pelaksanaan

1. Generate attestations menggunakan workflow identity yang didukung.
2. Tambahkan verify command yang memeriksa digest, repo dan workflow identity, bukan hanya download JSON.
3. Dokumentasikan consumer verification untuk image dan downloadable artifacts.

### Verifikasi dan syarat selesai

Tampered artifact atau wrong repository identity ditolak oleh verification fixture.

Catat command/test case, actual result, SHA sumber dan lokasi bukti dalam `docs/roadmap/evidence/M7.12.md` sesuai template. Jika kemampuan eksternal belum tersedia, pisahkan implementasi lokal yang selesai dari aktivasi yang terblokir; jangan centang item penuh. Jangan menonaktifkan check yang gagal agar item dianggap selesai.

## M7.13 — Retry release yang sama melanjutkan aset kurang tanpa bump/tag/release duplikat atau overwrite aset berbeda.

Publisher OCI melakukan read-before-write dan hanya reuse existing tag bila image ID, source SHA, versi, dan registry digest cocok; konflik ditolak tanpa mutasi. Workflow juga memeriksa ulang remote tag SHA sesudah verify serta memakai kembali GitHub Release published yang bertipe sesuai. Reconciler aset GitHub mem-preflight semua immutable-name conflict, mengunggah hanya aset yang kurang pada draft, lalu membaca ulang dan memverifikasi digest serta size; retry setelah respons upload hilang akan reuse aset yang diterima server. Bukti lokal ada di [M7.13](evidence/M7.13.md); simulasi hosted retry/race masih pending.

- **Prasyarat:** M7.10
- **Baca/periksa:** Release manifest; GitHub/GHCR APIs.
- **Deliverable:** Idempotent publication reconciler.

### Langkah pelaksanaan

1. Baca status remote sebelum create/update; bandingkan existing asset digest.
2. Upload hanya asset missing; berbeda digest pada nama immutable dianggap error investigasi.
3. Handle network timeout ambiguous dengan re-read state sebelum retry.

### Verifikasi dan syarat selesai

Rerun setelah timeout tidak membuat release/tag ganda; conflict digest tidak ditimpa.

Catat command/test case, actual result, SHA sumber dan lokasi bukti dalam `docs/roadmap/evidence/M7.13.md` sesuai template. Jika kemampuan eksternal belum tersedia, pisahkan implementasi lokal yang selesai dari aktivasi yang terblokir; jangan centang item penuh. Jangan menonaktifkan check yang gagal agar item dianggap selesai.

## M7.14 — Uji race, partial publish, upload gagal, token expired, tidak ada perubahan releasable, dan kegagalan sinkronisasi branch.

Local fault-injection covers ambiguous GHCR push and GitHub Release asset upload recovery, auth/network fail-closed behavior, immutable image/asset conflicts, published-release mutation refusal, no-release plans, and an actual stale expected-ref race against temporary bare Git remotes. Checksums and source tag SHA have workflow contract assertions. Hosted credential expiry and registry/API mutation remain pending.

- **Prasyarat:** M7.13, M7.08
- **Baca/periksa:** Planner/publisher tests; fake GitHub/registry adapters.
- **Deliverable:** Release fault-injection suite.

### Langkah pelaksanaan

1. Inject failure tiap boundary: version write, push, tag, draft, image, asset, publish, Pages, sync.
2. Test revoked credential, changed head, concurrent release, no-op dan old-run retry.
3. Pastikan test tidak menulis ke remote production; real dry-run hanya read-only.

### Verifikasi dan syarat selesai

Matriks failure mempunyai expected state/recovery; semua recovery paths teruji.

Catat command/test case, actual result, SHA sumber dan lokasi bukti dalam `docs/roadmap/evidence/M7.14.md` sesuai template. Jika kemampuan eksternal belum tersedia, pisahkan implementasi lokal yang selesai dari aktivasi yang terblokir; jangan centang item penuh. Jangan menonaktifkan check yang gagal agar item dianggap selesai.

## M7.15 — Rancang trigger eksplisit melalui reusable workflow/dispatch; jangan mengandalkan event GITHUB_TOKEN yang tidak memicu workflow berikutnya.

Local workflow trust validation now pins the trigger contract for release publishing, release preparation, and dependency automation. See [the workflow trigger and trust map](../operations/workflow-triggers.md) and [M7.15 evidence](evidence/M7.15.md). Hosted dispatch runs still need to verify the configured repository permissions and actual downstream run behavior.

- **Prasyarat:** M8.04, M2.01
- **Baca/periksa:** Workflow graph; token behavior; App permissions.
- **Deliverable:** Trigger graph dan trust validation.

### Langkah pelaksanaan

1. Dokumentasikan pemicu setiap state dan identitas token.
2. Gunakan workflow_call untuk langkah satu run dan dispatch eksplisit untuk trusted downstream bila perlu.
3. Batasi workflow_run ke repo/event/ref/SHA trusted; jangan execute artifacts PR tak tepercaya dengan secret.

### Verifikasi dan syarat selesai

Bot prepare memicu checks yang diperlukan tanpa recursion; arbitrary dispatch SHA ditolak.

Catat command/test case, actual result, SHA sumber dan lokasi bukti dalam `docs/roadmap/evidence/M7.15.md` sesuai template. Jika kemampuan eksternal belum tersedia, pisahkan implementasi lokal yang selesai dari aktivasi yang terblokir; jangan centang item penuh. Jangan menonaktifkan check yang gagal agar item dianggap selesai.

## M7.16 — Sediakan dry-run/release-plan artifact sebelum publikasi pertama dan tautkan seluruh bukti ke release.

`pnpm release:dry-run` composes the release preparation preview with exact source/baseline SHAs, proposed version, changelog/version diffs, file hashes, 25 phase-specific gates explicitly marked `not-run`, and 11 correctly named release/workflow assets. It identifies the actual public SBOM/checksum asset names and reports six hosted acceptance findings for SBOMs/checksum/provenance; local workflow implementation is not presented as hosted proof. The command requires a clean checkout so its report matches the source SHA. The manual [release-plan workflow](../../.github/workflows/release-plan.yml) is restricted to `dev`, uses read-only repository permission, and uploads the JSON plan for review. Current local output and limitations are recorded in [M7.16 evidence](evidence/M7.16.md).

- **Prasyarat:** M7.05, M7.06, M7.14, M7.15, M1.08
- **Baca/periksa:** Release pipeline lengkap; first stable decision.
- **Deliverable:** Dry-run report dan activation checklist.

### Langkah pelaksanaan

1. Jalankan dry-run menghasilkan plan JSON, changelog diff, version diff, assets list dan gates tanpa publish.
2. Validasi CI terhadap planned source dan review output.
3. Aktifkan first real publish hanya setelah dependency setup dan first-stable decision selesai.

### Verifikasi dan syarat selesai

Dry-run tidak membuat tag/release/image/public Pages; report berisi tindakan exact yang akan dilakukan.

Catat command/test case, actual result, SHA sumber dan lokasi bukti dalam `docs/roadmap/evidence/M7.16.md` sesuai template. Jika kemampuan eksternal belum tersedia, pisahkan implementasi lokal yang selesai dari aktivasi yang terblokir; jangan centang item penuh. Jangan menonaktifkan check yang gagal agar item dianggap selesai.
