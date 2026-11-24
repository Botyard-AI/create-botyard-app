import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import App from "./App"
import { configureApiFetch } from "./lib/api-fetch"
import "./index.css"

// What happens when the viewer's Botyard sign-in runs out (after about an hour):
// "reload" reloads the page, which signs them in again; "prompt" shows a banner
// and lets them reload when ready. Use "prompt" if the app has forms.
configureApiFetch({ onSessionExpired: "reload" })

const root = document.getElementById("root")
if (root === null) throw new Error("index.html has no #root element")

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
