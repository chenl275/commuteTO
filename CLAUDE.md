# CommuteTO

A real-time Toronto transit app combining TTC live service alerts, Google Maps traffic, and predictive commute times.

## Tech Stack

- Next.js (App Router)
- TypeScript
- Tailwind CSS
- FastAPI
- PostgreSQL
- Mapbox GL JS

## Coding Rules

- Use functional React components.
- Use TypeScript interfaces for props and API responses.
- Prefer Server Components unless client-side interactivity is required.
- Keep components modular and reusable.
- Never use inline CSS.
- Store secrets only in environment variables.

## UI Style

- Dark theme inspired by Apple Maps, Citymapper, and Transit.
- Glassmorphism cards with subtle animations.
- Mobile-first responsive layout.

## Official TTC Colors

Use TTC branding consistently throughout the app.

### Subway
- Line 1 Yonge–University — Yellow (#FFD200)
- Line 2 Bloor–Danforth — Green (#009A44)
- Line 4 Sheppard — Purple (#A05EB5)
- Line 5 Eglinton — Orange (#F58220)
- Line 6 Finch West — Grey (#8A8D8F)

### Surface Transit
- Regular buses — Red
- Streetcars — Red
- Blue Night Network buses — Blue

## Map Rules

- Draw subway lines with their official colors.
- Draw streetcar routes in red.
- Draw bus routes in blue.
- Delayed routes become orange.
- Suspended routes become red with warning icons.
- Stations are clickable and show arrivals, delays, elevators, and alerts.

## Folder Structure

app/
components/
lib/
types/

backend/
api/
services/
prediction/
database/