# Plan Transformasi MoonWitness: Next.js, UI Bible, Brand Assets, Efek Visual, dan SFX

## Tujuan dan batasan

Ubah app utama yang ada menjadi **satu app Next.js** yang memuat homepage publik dan Board. Lengkapi design system bersama agar dipakai homepage dan Board, termasuk komponen atomic, token, logo dan ikon vektor, ilustrasi, efek visual, loading state, serta audio SFX.

Tidak menambah app workspace baru. `apps/board` menjadi app Next.js; `apps/docs` tetap app dokumentasi terpisah karena sudah memiliki alur publikasi GitHub Pages sendiri.

“Lengkap” berarti seluruh kebutuhan UI yang benar-benar dipakai homepage dan Board tercakup dalam sistem bersama. Bukan berarti setiap fitur pada mockup otomatis dibuat, semua file harus vektor, atau semua media dimasukkan ke `@moonwitness/ui`.

Pelaksanaan detail visual Home, Board, workbench, aset sampai detail kecil, Bible terbaru, dan bukti review dicatat pada [`todo-ui.md`](../todo-ui.md). Checklist tersebut adalah satu-satunya rencana eksekusi visual agar tahapan tidak diduplikasi di sini.

## 1. Pembagian tanggung jawab package

Pertahankan dua package yang sudah ada; jangan membuat package atau contract JSON baru.

### `@moonwitness/ui` — sistem dan perilaku UI

Isi package ini dengan:

- Token semantik warna, typography, spacing, border, shadow, layering, dan motion.
- Komponen React reusable untuk level atomic dan komposisinya.
- Typed React icon wrappers yang berasal dari sumber ikon vektor yang sama.
- Pola visual reusable: panel, toolbar, tabel, form field, dialog, navigasi bersama bila memang dipakai di lebih dari satu tempat.
- Efek visual dan loading yang reusable serta konfigurasi suara SFX pada tingkat UI.

Susun komponen secara bertingkat: **foundation → primitive → composition → pattern/effect**. “Atomic” menjadi cara memahami tingkat komposisi; jangan membuat folder atau abstraksi baru hanya untuk memenuhi istilah atoms/molecules/organisms.

Komponen UI tidak mengambil alih data, auth, API, route produk, atau aturan domain.

### `@moonwitness/assets` — berkas media dan sumber vektor

Package ini sudah menyimpan logo, SVG, ikon, ilustrasi, font, manifest, dan informasi lisensi. Perluas tanggung jawabnya untuk memuat:

- Logo wordmark, symbol, lockup, dan favicon dalam SVG dengan variant light/dark dan mono yang diperlukan.
- Ikon vektor sebagai sumber canonical; generated React icon wrappers di `@moonwitness/ui` tetap berasal dari sumber yang sama. Jangan memelihara dua gambar ikon yang dapat berbeda sendiri.
- Ilustrasi dan artwork homepage/Board.
- Berkas sound effect.
- Manifest dan provenance/lisensi untuk seluruh asset baru.

Logo serta ikon antarmuka tetap vektor. Artwork sangat kompleks seperti cityscape/collage boleh berupa gambar raster teroptimasi supaya visualnya bagus dan tidak menghasilkan SVG besar. Gunakan file kecil per elemen; jangan menjadikan screenshot referensi sebagai background halaman.

## 2. UI Bible dan art direction

Jadikan `packages/ui/README.md` satu-satunya **UI Bible**. Pertahankan `packages/ui/TOKENS.md` untuk rincian token dan kontras. Pindahkan aturan yang relevan dari draft Board ke README lalu hapus dokumen aturan Board terpisah.

UI Bible menetapkan:

- Kapan memakai komponen dari `@moonwitness/ui` dan bagaimana menambah komponen baru.
- Pemisahan antara foundation, primitive, composition, pattern/effect, dan UI khusus app.
- Batas UI package terhadap logika produk.
- Penggunaan token dan aturan aksesibilitas.
- Aturan motion dan audio.
- Arah visual yang diturunkan dari empat referensi pengguna.

Interpretasi referensi:

- Gambar 1–2: homepage editorial, ilustratif, padat tekstur, dengan tinta gelap dan aksen magenta, cyan/biru, serta kuning.
- Gambar 3–4: bahasa visual untuk Board—panel padat, aksen neon, kolase, hirarki dashboard. **Gambar ini bukan spesifikasi fitur Board baru.**
- Audit brand mark yang sudah ada sebelum mengubah bentuk logo. Keputusan visual yang disetujui menetapkan crown + brush wordmark sebagai identitas utama baru; buat semua varian vektor dari satu sumber canonical dan jangan menjadikan artwork mockup sebagai logo final.
- Pertahankan kontras teks/fokus, hierarki konten, dan keterbacaan. Tekstur atau dekorasi tidak boleh membuat teks penting jadi gambar.
- Audit konten sebelum menulis homepage. Jangan mengarang statistik, crew, publishing pipeline, atau klaim bahwa fitur internal sudah tersedia untuk umum.

Peta warna visual baru diterapkan lewat token di `@moonwitness/ui`; hindari literal warna tersebar di Board dan homepage. Pertahankan alias lama hanya selama migrasi dan hapus setelah semua pemakai berpindah ke token semantik.

## 3. Perilaku motion, special FX, loading, dan sound

Sediakan efek yang benar-benar reusable untuk homepage dan Board. Hindari efek per halaman yang menyalin CSS/animasi yang sama.

### Efek visual

Cakupan:

- Tekstur/halftone, garis atau border editorial, glow, accent marker, orbit/signal motif, dan transisi antarpanel yang diambil dari arah visual referensi.
- Loading skeleton, spinner/progress, empty state, transisi route, dan status selesai/gagal.
- Efek khusus tetap dekoratif; tidak menggantikan label, state, progress, atau hasil aksi yang perlu dipahami pengguna.

Aturan:

- Motion harus mempunyai versi tanpa animasi untuk `prefers-reduced-motion`.
- Efek tidak boleh membuat konten sulit dibaca, mencegah input, atau terus mengonsumsi CPU ketika tidak terlihat.
- Efek berat dimuat hanya pada halaman yang memakainya; pakai CSS/SVG terlebih dahulu. Jangan menambah canvas/WebGL tanpa kebutuhan nyata dan anggaran performa.
- Efek loading harus menjelaskan state aktual. Jangan menampilkan animasi loading tanpa request atau proses yang berlangsung.

### Sound effects

Sound berlaku untuk homepage dan Board lewat satu API UI:

- File sumber SFX berada di `@moonwitness/assets`; API pemutaran dan kontrol berada di `@moonwitness/ui`.
- SFX **diaktifkan setelah interaksi pertama pengguna**, sesuai pilihan pengguna. Tidak ada autoplay sebelum interaksi.
- Berikan kontrol mute yang mudah ditemukan dan simpan preferensi pengguna secara lokal.
- Gunakan katalog sound bernama dan terpusat; jangan memasukkan pemanggilan berkas audio mentah di setiap komponen.
- Tetapkan penggunaan yang selektif—misalnya aksi sukses, alert penting, dan aksi eksplisit pada media. Hover, scroll, dan setiap klik biasa tidak berbunyi.
- Audio hanya memberi penekanan tambahan; status penting selalu disampaikan lewat teks/visual.
- File audio lazy-load saat dipakai, pendek, terkompresi, dan tercatat di manifest/lisensi. Tangani kondisi audio tidak tersedia tanpa membuat aksi UI gagal.

## 4. Migrasi satu app utama ke Next.js

Konversi `apps/board` ke Next.js App Router. Homepage dan Board berada dalam workspace/app ini.

### Route kanonis

| Fungsi          | Route                      |
| --------------- | -------------------------- |
| Homepage publik | `/`                        |
| Login           | `/login`                   |
| Registrasi      | `/register`                |
| Dashboard       | `/board`                   |
| Profil          | `/board/profile`           |
| Settings        | `/board/settings`          |
| Knowledge       | `/board/knowledge`         |
| Story workbench | `/board/stories/workbench` |
| Model           | `/board/m/:model`          |
| Record          | `/board/m/:model/:id`      |

Implementasi:

- Buat root layout, homepage, login/register routes, protected Board layout, not-found/error UI, theme setup, serta metadata.
- Homepage menjadi server-rendered; Board tetap client-interactive untuk auth, React Query, dan browser state.
- Ganti React Router di app dengan Next `Link` dan routing hooks. Hapus `BrowserRouter` dan dependency React Router setelah migrasi.
- Ubah dashboard lama dari `/` menjadi `/board`. Pertahankan `/login` dan `/register`.
- Alihkan URL Board lama seperti `/profile`, `/settings`, `/knowledge`, `/stories/workbench`, dan `/m/...` menuju canonical `/board/...`, sambil mempertahankan query string.
- Simpan return path login hanya sebagai path lokal yang divalidasi; jangan menerima redirect eksternal.
- Beri metadata homepage, Open Graph, sitemap/robots sesuai domain yang sudah ditentukan. Halaman login dan Board tidak diindeks.

Next.js App Router dapat melakukan render statis maupun server dan menyediakan metadata route; pilihan runtime ini mempertahankan fleksibilitas halaman publik serta route dinamis Board ([App Router](https://nextjs.org/docs/app), [Metadata API](https://nextjs.org/docs/app/getting-started/metadata-and-og-images)).

## 5. Pembuatan homepage dari referensi

Bangun homepage di `/`, bukan app baru.

Susunan awal yang dapat dievaluasi terhadap konten nyata:

1. Header/wordmark, navigasi, dan CTA login/masuk.
2. Hero editorial dengan artwork, headline, deskripsi singkat, dan CTA.
3. Bagian eksplorasi yang menjelaskan nilai produk dengan konten yang telah diverifikasi.
4. Bagian lanjutan untuk tema/arsip hanya bila produk memiliki konten publik yang sesuai.
5. Footer dengan link dan informasi brand yang benar.

Jadikan gambar 1–2 rujukan komposisi visual, bukan layout pixel-perfect wajib. Susun ulang untuk mobile: navigasi ringkas, satu CTA utama, hero yang terbaca, dan section yang tidak berubah menjadi grid terlalu padat. Jangan menyalin tulisan/statistik mockup tanpa verifikasi.

Homepage menggunakan UI package dan asset package: wordmark, ikon, token, button, badge, panel, typography, serta efek seperlunya. SEO metadata dirender ke HTML; konten penting tidak rasterized. Untuk artwork besar, optimasi ukuran, format, dan loading priority agar tidak memperlambat hero.

## 6. Migrasi Board ke design system bersama

Setelah struktur Next dan URL stabil, migrasikan seluruh kontrol lama agar satu file tidak perlu diedit berulang untuk routing dan UI sekaligus.

Inventaris sementara menunjukkan sekitar **60 kontrol JSX native**: tombol, input, select, dan textarea. Migrasikan seluruhnya ke komponen shared, termasuk Checkbox untuk input checkbox. Pertahankan behavior existing: label, disabled/focus, validation, controlled state, submit behavior, row propagation, indeterminate checkbox, file input, empty select value, dan textarea whitespace.

Gunakan Table package untuk pola tabel reusable. Jaga semantic table, keyboard/sort interaction, responsive visibility, overflow region, dan visual breakpoint.

Setelah kontrol dasar berpindah, rapikan shell dan pola Board berdasarkan referensi visual 3–4, namun pertahankan fitur, navigasi, serta domain flow yang sekarang. Jangan membuat Story Studio, crew registry, publishing queue, analytics, atau fitur mockup lain sebagai bagian visual transformation.

## 7. Gate aturan UI yang sederhana

Gunakan satu command manual dan otomatis: **`pnpm board:ui:check`**.

Selama migrasi, checker melaporkan kontrol lama dan mencegah penambahan baru. Jangan menjadikan baseline count sebagai aturan permanen—perhitungan jumlah per file saat ini bisa melewatkan pertukaran kontrol di file yang sama.

Setelah migrasi:

- Checker AST JSX menolak `<button>`, `<input>`, `<select>`, dan `<textarea>` langsung di Board.
- Checker juga menolak impor package melalui path internal `dist`; pemakaian harus lewat public subpath.
- Error menyebut path/baris, pengganti yang disarankan, dan command untuk memeriksa ulang.
- String/komentar dan komponen `<Button>` tidak dianggap pelanggaran.
- Satu checker yang sama dipakai manual, pre-push, dan quality CI.
- Hapus baseline JSON, update-baseline command, alias, dan report script setelah tidak diperlukan.

Aturan visual yang subjektif seperti “terlihat sesuai referensi” tidak dipaksa menjadi JSON. Hal itu divalidasi lewat UI Bible, review visual, dan screenshot tests.

## 8. Build, CI, asset pipeline, dan verifikasi

Perbarui `@moonwitness/assets` generator/validator agar logo, SVG icons, illustrations, audio, font provenance, manifest, dan lisensi dapat divalidasi dari satu inventory. `@moonwitness/ui` membangun typed icon wrappers dari ikon canonical yang sama, tanpa salinan manual.

Migrasi Next memerlukan pembaruan:

- Board scripts/dev server, typecheck, lint, dan build.
- Docker build/runtime dari static Nginx ke Next Node runtime.
- Same-origin proxy untuk `/api`, `/auth`, `/jsonrpc`, `/health`, `/livez`, `/readyz`, `/metrics`, `/notifications`, dan `/workflows`.
- Compose, release, image scan, dependency candidate, health checks, dan bundle budget yang saat ini mengacu pada Vite output.
- Playwright web server dan route assertions.

Penerimaan diuji per fase:

- Unit tests untuk token contrast/theme, UI components, keyboard/accessibility, SFX preference, lazy loading, serta asset manifest/license integrity.
- Validator test: raw JSX control gagal; string/comment/komponen bernama tidak gagal; import `dist` gagal.
- Visual/regression tests desktop dan mobile untuk homepage, login, Board shell, tabel, loading, empty, error, dan reduced motion.
- Accessibility check untuk kontras, focus, names/labels, keyboard interaction, motion preference, serta informasi state tanpa warna/suara saja.
- E2E untuk homepage public/metadata/CTA, route protection, login-return, legacy redirects, model deep links, API auth, dan workflow Board yang ada.
- Build/budget tests mengukur Next route output dan ukuran asset/audio awal; SFX tidak boleh masuk semua route awal bila tidak digunakan.
- Production image health check dan smoke test memastikan app merespons, API proxy bekerja, serta tidak ada secret di client bundle.

## Urutan kerja yang disarankan

1. Finalisasi UI Bible dan art direction dari referensi.
2. Audit logo/ikon/aset yang ada, lalu tetapkan sumber vektor canonical dan strategi sound asset.
3. Tambahkan fondasi/token dan aturan efek bersama di package.
4. Migrasikan `apps/board` ke Next; bangun route, login, dan homepage.
5. Migrasikan rute dan navigasi Board ke `/board/...`.
6. Ganti Docker/runtime/CI/E2E serta Same-origin API proxy.
7. Terapkan visual system ke homepage dan Board.
8. Migrasikan kontrol lama dan tabel ke package UI.
9. Perketat `pnpm board:ui:check`, buang baseline/alat sementara, dan jalankan verifikasi penuh.

## Asumsi yang dikunci

- Referensi 1–2 mengarahkan homepage; 3–4 hanya mengarahkan bahasa visual Board.
- SFX dipakai pada homepage dan Board, aktif setelah interaksi pertama, tersedia mute, dan tidak berbunyi untuk setiap klik/hover.
- Logo serta ikon interaktif berbentuk vektor; artwork kompleks boleh optimized raster.
- Homepage publik ada di `/`; dashboard lama pindah ke `/board`.
- Tidak menambah app atau package baru; `@moonwitness/ui` mengelola UI, `@moonwitness/assets` mengelola berkas media.
- Docs tetap berada pada publikasi GitHub Pages yang ada; deployment app utama tetap Docker/self-hosted.
