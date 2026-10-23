// Site-wide scripts. Loaded with `defer`, so the page has been parsed when this runs.

// Keep the footer year current.
const year = document.getElementById("year");
if (year) {
  year.textContent = new Date().getFullYear();
}
