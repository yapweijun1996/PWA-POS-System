# 04 · Visual design system

> 中文重点：轻量、清楚、触控友好；不要用很多装饰把总额和付款按钮淹没。

## Direction

Counter POS is a working identity for this kit only. Use an understated, warm-white workspace, dark ink typography and a teal action color. Products get pale illustrated backgrounds; stock/sync status stays textual and restrained. A compact brand mark resembles a counter with a receipt. Do not copy Odoo assets, payment-provider logos or a retailer's identity.

The proposed palette is ink #152D35, muted text #536A73, surface #FFFFFF, canvas #F3F6F5, border #D8E2DF, primary #0B6E61, primary-dark #07564C, primary-tint #E1F1EC, warning #8A5700 on #FFF2D6 and danger #B42318 on #FDEAE7. Tokens are in `design/tokens.json` and `design/tokens.css`. Contrast must be verified on actual components, including disabled states and focus outlines; palette selection alone is not an accessibility certification.

## Typography and spacing

Use a local/system sans-serif stack: Inter when installed, otherwise system UI, Segoe UI and Noto Sans CJK for Mandarin. No font binaries are distributed in this ZIP. Browser rendering varies slightly across OS. Body text 16px; supporting text 13–14px; screen title 26–30px; total 28–36px. Tabular numerals for money and quantity. Do not reduce the entire app to ERP-style 9pt text.

Spacing uses a 4px base: 4/8/12/16/24/32/48. Product cards use 16px padding, 16px corners and a low-contrast border. Buttons use 10–12px corners. Avoid heavy drop shadows; elevation is reserved for overlays and mobile order bars. Shadows must not be the only boundary indicator.

## Components and states

Primary button: one dominant action per task, 48–56px high. Secondary: white surface and border. Destructive: text plus confirmation when the action is irreversible. Loading buttons retain width, show progress and reject repeat activation. Text inputs are 44–48px high and at least 16px text on mobile. Money inputs use a decimal keyboard but validate locale-normalized text before converting to minor units.

ProductCard has default, keyboard focus, hover, selected feedback, out-of-stock and unavailable states. CartLine has quantity adjustment, removing/undo, permission-denied and price-changed states. StatusBadge always contains text: Online, Offline, Pending 3, Needs review. Never rely on green/red alone.

Dialogs have a visible title, labeled close action, a predictable footer and focus restoration. On phones the order/payment flow occupies the viewport instead of stacking small nested modals. Toasts avoid covering totals and remain long enough to read; critical errors persist inline.

## Responsive tokens

Phone content gutter 16px; tablet 20px; desktop 24–32px. Keep the mobile CTA above `env(safe-area-inset-bottom, 0px)`. Use 100dvh with a compatible fallback, opaque top safe-area surfaces and scrollable middle content. Do not force a fixed viewport height that hides fields behind the software keyboard. Input focus should scroll into view.

At 390×844 and 430×932: two-column product grid, no persistent desktop rail, full-width order sheet. At 768×1024: two-column products with compact or collapsed cart depending on available width. At 1024×768 and 1440×900: product/cart split. Reflow to the phone pattern when zoom reduces the usable CSS width.

## Motion and themes

Use 120–180ms opacity/transform transitions for small UI feedback. Honor prefers-reduced-motion. No animation during price calculation or payment confirmation. V1 is light-only; dark theme is explicitly deferred, so no untested “dark-mode supported” badge. Both manifest theme color and shell top surface match light-mode ink/surface choices.

## Assets and authority

PNG screens show a synthetic store with tax disabled. Their totals match the canonical demo fixture. SVG wireframes express hierarchy and behavior; they are editable source assets, not a ready-made Figma component library. The AI exploratory poster is non-authoritative: generated names, license claims, percentages, schema labels and payment capability text are not implementation requirements. Follow this specification and tokens instead.

## Visual acceptance

Review at target sizes, 200% zoom, keyboard navigation, long Mandarin strings, large totals, missing product images, empty cart, storage error and offline mode. No horizontal page overflow; no text truncation that hides the distinguishing part of a product name; no sticky footer over the final line; no small unlabeled icon targets. The atlas is a design review aid, not proof that a production app passes these checks.
