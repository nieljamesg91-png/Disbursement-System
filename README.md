# School Monitoring System

A browser-based school disbursement monitoring system for GitHub Pages or Vercel. The dashboard opens directly without a login and stores updates in the current browser.

## Publish with GitHub Pages

1. Create a GitHub repository and upload the files in this folder.
2. In the repository, open **Settings → Pages** and set the build and deployment source to **GitHub Actions**.
3. Push to the `main` or `master` branch. The workflow in `.github/workflows/deploy-pages.yml` publishes the site.

## Publish with Vercel

1. Import the GitHub repository in the Vercel dashboard.
2. Leave the framework preset as **Other** and the build command and output directory empty.
3. Deploy. Vercel serves `index.html` and the adjacent static files directly.

## Data and privacy

The starting records are in `data.js`. New and edited records are saved in the browser's IndexedDB on the device where the site is used; they do not sync to other devices or users. IndexedDB does not impose this app's former small local-storage limit, so the tracker can hold well over 1,500 schools, subject to the browser's available disk quota.

To save school photos directly as image files on the computer, open the site in a recent Chrome or Edge browser, select **Choose photo folder**, and grant access to a folder. Uploaded photos (up to 1 MB each) are written to that folder; the browser stores their filenames with the records. The folder permission is managed by the browser and may need to be granted again. Other browsers can use the tracker records, but may not support saving images directly to a chosen folder.

Use **Export JSON backup** regularly. Backups include photo data so they can be restored on another browser or device. Clearing browser data can remove locally saved records; photos already written to the selected folder remain there.

Use **Download Excel** to export a formatted Excel report of the records matching the current tracker search and filters. The report includes a generation date, status totals, and a styled school register.

`data.js` contains contact names and disbursement remarks. Anyone who can access a public repository or deployment can view those original records. Confirm that you are authorized to publish them, or make the repository and deployment private before sharing.
