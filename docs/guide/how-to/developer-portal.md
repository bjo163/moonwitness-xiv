# Menjalankan portal dokumentasi

**Pembaca:** contributor dokumentasi dan frontend. **Prasyarat:** Node.js 22, pnpm 11, dan dependency workspace terpasang. Portal ini adalah SPA statis; API dan database tidak diperlukan.

## Build dan preview

```bash
pnpm docs:build
pnpm --filter @moonwitness/docs preview
```

Buka base path lokal yang ditampilkan oleh Vite, biasanya `http://localhost:4173/moonwitness-xiv/`.
Untuk development mode jalankan `pnpm --filter @moonwitness/docs dev`; bundle panduan harus dibuat
dengan `pnpm docs:build` terlebih dahulu.

## Fitur dan routing

Navigasi dan pencarian berasal dari `docs/guide/navigation.json` serta bundle deterministik yang
dibuat oleh `pnpm docs:build`. Tekan `/` untuk fokus ke search, lalu gunakan hasil sebagai tautan
keyboard-accessible. Menu sidebar dapat dibuka pada viewport sempit. Konten menggunakan parser
Markdown aman dengan tabel/task-list GitHub; raw HTML tidak dieksekusi.

Build menggunakan base path `/moonwitness-xiv/`. File `404.html` adalah fallback client router untuk
reload deep link GitHub Pages. `pnpm test:docs-portal` memeriksa nested reload, search, keyboard,
sidebar responsif, 404 dan tidak adanya overflow horizontal pada layar kecil.

Keputusan framework dan tradeoff tercatat di [ADR portal docs](../../decisions/0003-docs-portal.md).
