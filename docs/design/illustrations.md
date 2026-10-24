# MoonWitness interface illustrations

`@moonwitness/assets/illustrations/*` provides light and dark decorative SVGs for empty, no-result, no-activity, access-denied, not-found, offline, and onboarding states, plus a subtle orbit pattern. Keep the matching explanation, recovery steps, and actions in regular HTML so the flow still works without the image.

Use a matching theme variant, set an explicit rendered size or a responsive width, and reserve its aspect ratio to avoid layout shift:

```tsx
<img
  src="/assets/illustrations/no-results-light.svg"
  alt=""
  width="164"
  height="152"
  className="h-auto w-40"
/>
<h2>No matching records</h2>
<p>Try a broader search or clear the active filters.</p>
```

The SVG has its own accessible title for direct viewing. When used beside equivalent text, use empty `alt` so assistive technology does not announce the same state twice. Theme choice and user-facing copy remain application responsibilities.

The generated light/dark contact sheet is [illustration-contact-sheet-current.png](./assets/illustration-contact-sheet-current.png).
