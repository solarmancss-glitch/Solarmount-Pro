# Solar 3D Design & Analytics Platform

An interactive, web-based 3D platform for modeling solar installations, performing spatial analysis, and managing project credits.

## ⚠️ IMPORTANT: Run With Vite, NOT Live Server

This project is built with **Vite + React + TypeScript** and uses ES modules.

- **DO NOT** use VS Code's **Live Server** extension (the "Go Live" button) for this project.
- Opening `index.html` directly in a browser **will not work** either.

**Live Server causes this exact error:**

```
Failed to load module script: Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of "application/octet-stream"
```

This happens because Live Server does not understand Vite's module bundling and serves `.tsx` files with the wrong MIME type.

### ✅ How to Run (The Correct Way)

1. In VS Code, the Vite dev server **starts automatically** when you open this folder (configured via `.vscode/tasks.json`).
2. If it doesn't start automatically, run this command in the terminal:

   ```bash
   npm run dev
   ```

3. Vite will print a URL, typically: **http://localhost:5173/** (a different port if 5173 is busy)
4. Open that URL in your browser.

## Features

- **3D Viewport**: Interactive canvas for viewing, positioning, and inspecting 3D solar assets.
- **Map & Location Integration**: Leaflet map integration for selecting geographic coordinates and mapping site context.
- **Solar & Spatial Analytics**: Custom analytics engine for solar tracking and positioning calculations.
- **User Authentication & Credits**: Integrated Supabase backend handling user profiles, auth modals, and database migrations for credit management.
- **Inspector & Control Tools**: Real-time property inspector, customizable toolbars, and dynamic HUD overlay.

## Tech Stack

| Layer      | Technology                          |
| ---------- | ----------------------------------- |
| Framework  | React 18 with TypeScript            |
| Build Tool | Vite                                |
| Styling    | Tailwind CSS, PostCSS               |
| 3D & Map   | Three.js / WebGL, Leaflet           |
| Backend    | Supabase (PostgreSQL, Auth)         |

## Project Structure

```
├── .vscode/                # VS Code config (auto-start Vite, disable Live Server)
├── supabase/
│   └── migrations/         # PostgreSQL database schemas and migrations
├── src/
│   ├── components/         # React UI components (Viewport, Maps, Toolbars, Modals)
│   ├── lib/                # Core business logic (Auth, Scene Engine, Solar Calculations)
│   ├── App.tsx             # Main application wrapper
│   ├── main.tsx            # Application entry point
│   └── index.css           # Global styles and Tailwind directives
├── package.json            # Project dependencies and scripts
└── vite.config.ts          # Vite build configuration
```

## Getting Started

### Prerequisites

- **Node.js** (v18 or higher)
- **npm** or **yarn**

### Installation

```bash
git clone https://github.com/your-username/your-repo-name.git
cd your-repo-name
npm install
```

### Environment Variables

Create a `.env` file in the root directory based on `.env.example`:

```
VITE_SUPABASE_URL=your_supabase_project_url
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
```

### Run the development server

```bash
npm run dev
```

### Build for production

```bash
npm run build
```

### Database Setup

This project uses Supabase for database and authentication management. To apply database migrations locally or in your Supabase instance, run the migration scripts located in `supabase/migrations/`:

```bash
npx supabase db push
```

### Routes

SolarMount Pro ships with two main views (client-side routing via React Router):

| Route      | Page                                        |
| ---------- | ------------------------------------------- |
| `/`        | Marketing landing page (hero, features, pricing, FAQ) |
| `/studio`  | The 3D design studio (the full application) |
| `/app`     | Redirects to `/studio`                      |
| anything   | Redirects to `/`                            |

The studio is **lazy-loaded**: only the light landing page bundle is
downloaded first, and the heavy 3D studio chunk loads only when the user
opens `/studio`.

### Deployment & your own domain

Deploy the `dist/` folder to any static host. SPA rewrites are included
out of the box so deep links like `/studio` work on refresh:

- **Netlify** — `public/_redirects` is copied into the build
  (`/*  /index.html  200`).
- **Vercel** — `vercel.json` applies the same fallback automatically.
- **Any other host** — configure a rewrite/fallback of all paths to
  `/index.html`, or use the route `/studio` directly from the landing page.

Recommended: point your own domain (e.g. `solarmountpro.com`) at the host,
then link to it from your personal portfolio as an external project card
instead of embedding the full app in the portfolio subpath.

## License

Distributed under the MIT License. See LICENSE for more information.