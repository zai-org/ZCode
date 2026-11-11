---
name: frontend-design
description: Create distinctive, production-grade frontend interfaces with high design quality. Use this skill when building web components, pages, or applications. Generates creative, polished code that avoids generic AI aesthetics.
triggers:
  - "frontend design"
  - "ui design"
  - "ux design"
  - "web design"
  - "production ui"
od:
  mode: design-system
  category: design-systems
  upstream: "https://github.com/anthropics/skills/tree/main/frontend-design"
---
<!-- Modified by ZCode: front matter, title and introduction adapted for the design plugin. Derived from anthropics/skills skills/frontend-design (Apache-2.0); license in LICENSE.txt beside this file. -->

# Frontend Design

Create distinctive, production-grade frontend interfaces that avoid generic "AI slop" aesthetics. Implement real working code with exceptional attention to aesthetic details and creative choices.

## Design Thinking

Before coding, understand the context and commit to a BOLD aesthetic direction:

- **Purpose**: What problem does this interface solve? Who uses it?
- **Tone**: Pick an extreme — brutally minimal, maximalist chaos, retro-futuristic, organic/natural, luxury/refined, playful/toy-like, editorial/magazine, brutalist/raw, art deco/geometric, soft/pastel, industrial/utilitarian
- **Constraints**: Technical requirements (framework, performance, accessibility)
- **Differentiation**: What makes this UNFORGETTABLE? What's the one thing someone will remember?

**CRITICAL**: Choose a clear conceptual direction and execute it with precision. Bold maximalism and refined minimalism both work — the key is intentionality, not intensity.

## Frontend Aesthetics Guidelines

### Typography
Choose fonts that are beautiful, unique, and interesting. Avoid generic fonts like Arial and Inter; opt for distinctive choices that elevate the interface. Pair a distinctive display font with a refined body font.

### Color & Theme
Commit to a cohesive aesthetic. Use CSS variables for consistency. Dominant colors with sharp accents outperform timid, evenly-distributed palettes.

### Motion
Use animations for effects and micro-interactions. Prioritize CSS-only solutions for HTML. Use Motion library for React when available. Focus on high-impact moments: one well-orchestrated page load with staggered reveals creates more delight than scattered micro-interactions.

### Spatial Composition
Unexpected layouts. Asymmetry. Overlap. Diagonal flow. Grid-breaking elements. Generous negative space OR controlled density.

### Backgrounds & Visual Details
Create atmosphere and depth rather than defaulting to solid colors. Apply creative forms like gradient meshes, noise textures, geometric patterns, layered transparencies, dramatic shadows, decorative borders, custom cursors, and grain overlays.

## Anti-Patterns (What NOT to Do)

**NEVER use:**
- Overused font families (Inter, Roboto, Arial, system fonts)
- Cliched color schemes (purple gradients on white backgrounds)
- Predictable layouts and component patterns
- Cookie-cutter design that lacks context-specific character

**NEVER converge** on common AI choices (Space Grotesk, for example) across generations.

## Implementation

Match implementation complexity to the aesthetic vision:
- Maximalist designs need elaborate code with extensive animations and effects
- Minimalist designs need restraint, precision, and careful attention to spacing, typography, and subtle details

Elegance comes from executing the vision well.

## Output Requirements

Implement working code (HTML/CSS/JS, React, Vue, etc.) that is:
- Production-grade and functional
- Visually striking and memorable
- Cohesive with a clear aesthetic point-of-view
- Meticulously refined in every detail

Vary between light and dark themes, different fonts, different aesthetics. No design should be the same.

---

*Remember: Claude is capable of extraordinary creative work. Don't hold back — show what can truly be created when thinking outside the box and committing fully to a distinctive vision.*
