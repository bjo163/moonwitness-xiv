# Panduan Roadmap MoonWitness

Roadmap ini terdiri dari 148 kartu M-series dan 65 kartu K-series (213 task). Checklist `ROADMAP.md` tetap sumber status. K-series melacak rebuild knowledge XIV dan berada di [kartu AI lokal](12-local-ai-rebuild.md). Mulai dari [jalur rilis aktif](ACTIVE-PLAN.md) untuk melihat gate yang benar-benar menahan rilis dan [backlog tertunda](EXECUTION-BACKLOG.md) untuk item yang tetap dilacak tetapi tidak perlu menghambat rilis pertama. Riwayat batch lama ada di [arsip eksekusi](EXECUTION-HISTORY-2026-10-15.md).

## Urutan membaca untuk agen baru

1. Baca [master checklist](../../ROADMAP.md) untuk scope, keputusan pengguna dan status terbaru.
2. Baca [jalur rilis aktif](ACTIVE-PLAN.md), lalu cek [backlog tertunda](EXECUTION-BACKLOG.md) untuk syarat membuka pekerjaan opsional kembali.
3. Baca [EXECUTION.md](EXECUTION.md) untuk prosedur kerja paralel, validasi, commit/push, dan handoff.
4. Pilih ID melalui [tasks.json](tasks.json). Index ini berisi judul, dependensi, file detail dan deliverable. Status checklist berada di `ROADMAP.md`.
5. Buka kartu pada dokumen milestone di bawah dan baca sumber kode yang disebutkan.
6. Untuk pekerjaan automation, baca [AUTOMATION-CONTRACTS.md](AUTOMATION-CONTRACTS.md).
7. Untuk desain dan UI, baca [DESIGN-SPEC.md](DESIGN-SPEC.md).
8. Untuk test, baca [TEST-SCENARIOS.md](TEST-SCENARIOS.md).
9. Untuk Issues/auto-PR/commit-push, baca [ISSUE-SYNC-CONTRACT.md](ISSUE-SYNC-CONTRACT.md).
10. Untuk otoritas field dan lifecycle Issues, baca [kebijakan issue sync](../engineering/issue-sync-policy.md).
11. Schema dan validator silang roadmap/issue index ada di [task schema](task.schema.json) dan `pnpm automation:check:roadmap`.
12. Salin [template evidence](evidence/TEMPLATE.md) untuk hasil pekerjaan.

## Kartu kerja

| File                                                 | ID            | Fokus                                                                 |
| ---------------------------------------------------- | ------------- | --------------------------------------------------------------------- |
| [Baseline](00-baseline.md)                           | M0.01–M0.08   | Inventarisasi, baseline, kontrak dan jumlah seed                      |
| [Governance](01-governance.md)                       | M1.01–M1.12   | Dua branch, promosi, rulesets dan sinkronisasi                        |
| [CI](02-ci.md)                                       | M2.01–M2.13   | Reusable verification, script root, gate dan artifacts                |
| [Board](03-board.md)                                 | M3.01–M3.11   | Browser E2E, visual, aksesibilitas dan data flows                     |
| [Backend](04-backend.md)                             | M4.01–M4.16   | ORM, auth, akses, jobs/outbox, restore dan performa                   |
| [Design system](05-design-system.md)                 | M5.01–M5.17   | Asset original, UI, grafik, katalog dan migrasi Board                 |
| [Dokumentasi](06-documentation.md)                   | M6.01–M6.11   | Generated docs, README, portal dan Pages                              |
| [Release](07-release.md)                             | M7.01–M7.16   | Version/changelog, SHA, publication, recovery                         |
| [Security/maintenance](08-security-maintenance.md)   | M8.01–M8.11   | Least privilege, updater, scheduled jobs dan incident                 |
| [Addon](09-addons.md)                                | M9.01–M9.08   | Notification, storage, workflow, integration, organization            |
| [Acceptance](10-acceptance.md)                       | M10.01–M10.10 | Bukti satu siklus nyata dan handoff                                   |
| [Local AI knowledge rebuild](12-local-ai-rebuild.md) | K0-001–K9-007 | Domain ownership, rights, privacy, local AI, migration and acceptance |

Lihat juga [Issues dan delivery — M11.01–M11.15](11-issues-delivery.md): issue sync, lifecycle, commit/push, auto-PR/merge dan recovery.

Untuk jadwal operasi, pemilik lane, eskalasi dan pemulihan, lihat [maintenance runbook](../engineering/maintenance-runbook.md).

## Gelombang pelaksanaan

Nomor milestone bukan urutan serial mutlak. Gunakan dependsOn di index. Contoh: M1.06 harus menunggu M2.05 agar ruleset tidak mengunci repo sebelum check tersedia. Hosted CI adalah verifikasi setelah push, bukan antrean untuk memulai local batch independen berikutnya.

1. **Core and access:** close critical persisted permission/tenant/seed gaps (M10.01) while refreshing Board + PostgreSQL user journey (M3.11/M9.06).
2. **Security and docs:** disposition scanner/credential issues and operator readiness (M8.03/M8.11), validate user quickstart/output safety, and keep Pages publication behind the protected main gate.
3. **Release machinery:** refresh clean-source version/changelog plan, exact-SHA policy, same-digest assets/SBOM/provenance, retry/failure behavior, and trusted event flow (M7/M10).
4. **Protected promotion:** obtain fresh CODEOWNER approval, require all checks, verify exact main SHA and no app deployment, then prove Pages/release behavior only through their authorized workflows.
5. **Issue/PR lifecycle:** finish local planner/render/idempotency/fault coverage while hosted issue writes and main activation remain separately gated (M11).
6. **Post-release operations:** stable docs retention, recurring schedules/incident recovery, optional GitHub Projects and inbound issue proposals after their re-entry conditions in [ACTIVE-PLAN.md](ACTIVE-PLAN.md).

## Batas penyelesaian

- **Platform milestone:** M0–M8, M11 dan acceptance M10 yang relevan telah terbukti. Core Issues sync M11.01–M11.06 dapat berjalan paralel setelah baseline; end-to-end lifecycle M11.14 menunggu gate/release siap.
- **Extension milestone:** M9 diselesaikan per addon; jangan menandai seluruh master roadmap selesai ketika M9 masih pending.
- **Maintenance:** jadwal berulang merupakan operasi ongoing. Item setup selesai setelah workflow tersedia dan satu run terbukti; pekerjaan rutin tetap berlanjut.
- Roadmap hanya lengkap jika gap, tugas tertunda, unsupported capability, dan pemilik tindak lanjut tetap tercatat.
