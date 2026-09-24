# DESIGN.md — Prime Agent Web Cockpit

## 1. Direction & Product Identity
- **Product**: Prime Agent Web (local developer cockpit & mission control for autonomous agent sessions).
- **Audience**: Software engineers, systems developers, AI operators.
- **Theme**: **Permanent Dark Mode**. The user explicitly decided on a permanent dark theme for extended terminal/cockpit work sessions without light mode switching (R-21 developer mission-control rationale).

## 2. Dials (Liveliness Toolkit)
- **ENERGY**: `2` (Balanced developer tool: responsive, crisp typography, clean status chips).
- **RHYTHM**: `2` (Clear structure: sidebar drawer, live chat transcript, inline tool cards, composer).
- **MOTION**: `1` (Functional motion: smooth hover states, fadeUp transitions, no gratuitous animations).

## 3. Color Palette
- **Backgrounds**: `--bg: #0a0e13`, `--bg-2: #10151c`, `--bg-3: #171e27`.
- **Borders**: `--border: #1f2833`, `--border-2: #2c3746`.
- **Foreground Text**: `--text: #e6edf3`, `--text-dim: #8b98a5` (WCAG AAA compliant).
- **Accents**:
  - Primary Accent: `--accent: #58d5a9` (Mint Green for activity & success).
  - Secondary Accent: `--accent-2: #4c8dff` (Blue for links & user prompts).
  - Status Indicators: `--danger: #f85149` (Red), `--warn: #d29922` (Amber), Spend Gold: `#e3b341`.

## 4. Typography & Standards
- **Sans Font**: `Inter`, system UI.
- **Mono Font**: `JetBrains Mono`, `Fira Code`, monospace.
- **Math**: KaTeX LaTeX formulas (`$$` display, `$` inline) with local vendor offline support.
- **Tables**: GFM with alignment, borders, and horizontal overflow containment.
