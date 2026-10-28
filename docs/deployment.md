# Deployment

## Deploy to GitHub Pages

1. Create a GitHub repository named `epub-tts`. Push the project to the `main` branch.
2. In the repository settings, open "Pages". Set "Source" to "GitHub Actions".
3. The workflow `.github/workflows/pages.yml` builds and deploys on each push to `main`.
4. Open `https://<user>.github.io/epub-tts/`.

The workflow sets `VITE_BASE` to `/<repository name>/`. To build by hand for another path, run `VITE_BASE=/other/ npm run build`.