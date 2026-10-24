# Release dan upgrade

**Pembaca:** maintainer package/addon dan operator yang meninjau perubahan versi. **Prasyarat:**
baca [compatibility policy](../../engineering/compatibility.md), [promotion policy](../../decisions/0001-platform-contracts.md),
serta hasil CI pada source SHA yang dipilih. **Verifikasi lokal:** `pnpm release:check` dan
`pnpm release:check v1.0.0-rc.1` (samakan tag dengan versi root yang sedang dicek) dan
`pnpm test:release-classification` harus lolos.

Alur image kandidat dan promosi job terpisah dijelaskan di [release artifact flow](../../operations/release-artifact-flow.md).

## Sebelum upgrade

1. Identifikasi versi monorepo/addon saat ini, source SHA target, perubahan breaking dan migrasi data.
2. Buat backup terverifikasi dan uji upgrade pada restore terisolasi sebelum menyentuh data penting.
3. Pastikan CI lulus pada commit candidate dan branch head tidak berubah saat release plan dibuat.
4. Review deprecation, session invalidation, client/API compatibility dan recovery steps.

## Addon versions

Addon menggunakan version `major.minor.patch`. Penambahan kompatibel mempertahankan external IDs
dan nilai user yang ada. Perubahan backfill wajib menjadi explicit forward upgrade hook transaction
yang teruji. Sistem tidak menjanjikan downgrade otomatis atau tebakan aman untuk drop/rename/type
change. Bila hook gagal, transaksi harus rollback dan issue diselesaikan sebelum dicoba kembali.

### ORM instance method compatibility for 1.0.0-rc

Addon code that calls mutations on a model instance must use `record.update(values)` and
`record.remove(hardDelete?)`. The old instance methods `record.write(...)` and
`record.unlink(...)` were renamed because they collide with addon fields named `write` or
`unlink`, which could silently discard values such as access-grant flags. Static calls
`Model.write(ids, values)` and `Model.unlink(ids, hardDelete)`, plus client repository
methods, are unchanged. `defineModel` now fails early if a field conflicts with any
inherited ORM instance member. This is a source-level addon change and requires no SQL
migration or stored-record rewrite.

## Branch dan publikasi

`dev` menjadi integrasi; `main` menerima promosi melalui pull request dan required CI. Perubahan
sensitif memerlukan review CODEOWNER yang fresh. Version bump/changelog/tag/image/docs publication
diatur oleh release workflow dan keputusan stable release eksplisit; mendorong kode ke `dev` sendiri
bukan stable release atau production deployment.

### Siklus release otomatis

`release-orchestrate.yml` dijalankan setelah CI `push` pada `main` selesai atau lewat dispatch manual
yang hanya menerima `main`. Workflow ini memverifikasi source SHA masih sama dengan `main` saat ini,
memakai checkout exact SHA, dan mewajibkan `ci-gate` sukses terbaru pada SHA tersebut sebelum
menyentuh tag. Baseline tag wajib sudah memiliki GitHub Release yang published; tag tanpa release
memblokir orchestration dengan status `baseline-unpublished` dan tidak boleh dihapus, dipindah, atau
di-retag untuk melewatinya.

1. **Release candidate:** dispatch **Orchestrate release** dengan `channel=rc` atau tunggu CI `main`
   berikutnya. Orchestrator menyiapkan versi di `dev`; preparation push memicu CI dan promotion
   secara eksplisit karena push `GITHUB_TOKEN` tidak memicu workflow. Setelah PR promosi di-merge dan
   CI `main` selesai, orchestrator membuat tag pada SHA `main` hasil verifikasi lalu men-dispatch
   publication. Publikasi RC tidak mengubah alias `latest`.
2. **Stable:** setelah RC terakhir published, dispatch `channel=stable` dengan
   `confirm_version=vX.Y.Z` untuk menyiapkan versi final di `dev`. Setelah promosi di-merge, dispatch
   lagi dengan nilai konfirmasi yang sama. Job stable berjalan di environment `release`;
   `release.yml` memeriksa ulang nilai konfirmasi sebelum menulis registry.
3. **Hotfix:** dispatch `channel=hotfix`. Channel ini hanya menerima perubahan patch dan tetap
   memerlukan konfirmasi stable sebelum persiapan dan publikasi.

Jangan mengandalkan push bot atau tag yang dibuat `GITHUB_TOKEN` untuk memulai workflow lain.
Periksa hasil run dispatch dan SHA head yang tepat; status lokal bukan bukti publikasi hosted. Detail
kontrak ada di [release artifact flow](../../operations/release-artifact-flow.md) dan
[workflow trigger map](../../operations/workflow-triggers.md).

Lihat [master roadmap](../../../ROADMAP.md) untuk status readiness aktual. Jangan menganggap static
UI catalog sebagai docs portal yang telah dipublikasikan; aktivasi Pages memiliki acceptance M6.06
dan M6.07 sendiri.
