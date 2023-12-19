document.getElementById('clearHighlights').addEventListener('click', function() {
  const highlightedSpans = document.querySelectorAll('span.highlight');
  highlightedSpans.forEach(span => {
    // Remove the styles and class added for highlighting
    span.style.backgroundColor = '';
    span.style.color = '';
    span.style.fontWeight = '';
    span.classList.remove('highlight');
  });
  console.log("Highlights cleared"); // Debug log
});
