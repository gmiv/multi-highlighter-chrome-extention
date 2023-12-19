document.addEventListener('dblclick', function(event) {
  const selectedText = window.getSelection().toString().trim();
  console.log("Selected text:", selectedText); // Debug log
  if (selectedText) {
    highlightWord(selectedText, generateRandomBrightColor());
  }
});

function generateRandomBrightColor() {
  const brightColors = [
    'rgb(255, 0, 0)',   // Red
    'rgb(0, 255, 0)',   // Green
    'rgb(0, 0, 255)',   // Blue
    'rgb(255, 255, 0)', // Yellow
    'rgb(255, 0, 255)', // Magenta
    'rgb(0, 255, 255)', // Cyan
    'rgb(255, 165, 0)', // Orange
    'rgb(255, 105, 180)', // Hot Pink
    'rgb(60, 179, 113)', // Medium Sea Green
    'rgb(138, 43, 226)', // Blue Violet
    'rgb(0, 128, 128)', // Teal
    'rgb(255, 69, 0)', // Orange Red
    'rgb(75, 0, 130)', // Indigo
    'rgb(123, 104, 238)', // Medium Slate Blue
    'rgb(34, 139, 34)', // Forest Green
    'rgb(220, 20, 60)'  // Crimson
  ];
  const randomIndex = Math.floor(Math.random() * brightColors.length);
  return brightColors[randomIndex];
}

function highlightWord(word, color) {
  function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  const escapedWord = escapeRegExp(word);
  const regexWord = new RegExp(`\\b${escapedWord}\\b`, 'gi');

  function highlightTextNode(node) {
    const parts = node.nodeValue.split(regexWord);
    if (parts.length > 1) {
      const fragment = document.createDocumentFragment();
      parts.forEach((part, index) => {
        fragment.appendChild(document.createTextNode(part));
        if (index < parts.length - 1) {
          const highlight = document.createElement('span');
          highlight.classList.add('highlight');
          highlight.style.backgroundColor = color;
          highlight.style.color = 'black';
          highlight.style.fontWeight = 'bold';
          highlight.textContent = word;
          fragment.appendChild(highlight);
        }
      });
      node.parentNode.replaceChild(fragment, node);
    }
  }

  function traverseAndHighlight(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      highlightTextNode(node);
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.nodeName !== 'SCRIPT' && node.nodeName !== 'STYLE' && !node.hasAttribute('srcset')) {
        node.childNodes.forEach(child => traverseAndHighlight(child));
      }
    }
  }

  traverseAndHighlight(document.body);
}
