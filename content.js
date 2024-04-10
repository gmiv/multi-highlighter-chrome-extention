document.addEventListener('dblclick', function(event) {
  const selectedText = window.getSelection().toString().trim();
  if (selectedText) {
    // Copy selected text to clipboard
    navigator.clipboard.writeText(selectedText).then(() => {
      console.log("Copied to clipboard:", selectedText);
    }).catch(err => {
      console.error('Could not copy text: ', err);
    });

    // Attempt to remove any existing color picker to prevent duplicates
    const existingPicker = document.getElementById('inlineColorPickerContainer');
    if (existingPicker) {
      existingPicker.remove();
    }

    // Create the container for the inline color picker and presets
    const colorPickerContainer = document.createElement('div');
    colorPickerContainer.id = 'inlineColorPickerContainer';
    colorPickerContainer.style.position = 'fixed';
    colorPickerContainer.style.top = `${event.clientY}px`;
    colorPickerContainer.style.left = `${event.clientX}px`;
    colorPickerContainer.style.padding = '10px';
    colorPickerContainer.style.backgroundColor = '#FFF';
    colorPickerContainer.style.border = '1px solid #CCC';
    colorPickerContainer.style.borderRadius = '5px';
    colorPickerContainer.style.zIndex = '10000'; // Ensure it's above most content

    // Add the HTML color input
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.id = 'inlineColorPicker';
    colorInput.onchange = function() {
      // When color is chosen, store it, highlight and bold text, then remove picker
      chrome.storage.local.set({highlightColor: this.value}, () => {
        highlightAndBoldWord(selectedText, this.value);
        colorPickerContainer.remove(); // Remove picker after selection
      });
    };
    colorPickerContainer.appendChild(colorInput);

    // Preset colors
    const presets = [
      '#FF007F', // Neon Pink
      '#00FF00', // Bright Green
      '#00FFFF', // Aqua
      '#FFD700', // Gold (Neon-like Yellow)
      '#FF5733', // Existing Preset, consider changing to a more neon shade if desired
      '#33FF57', // Bright Neon Lime
      '#3357FF', // Bright Blue
      '#F333FF', // Bright Magenta
      '#FF3357', // Neon Red
      '#FF00FF', // Neon Purple
      '#FFFF00', // Electric Yellow
      '#00FF99', // Neon Mint
    ];
    
    presets.forEach(color => {
      const presetButton = document.createElement('button');
      presetButton.style.backgroundColor = color;
      presetButton.style.width = '24px';
      presetButton.style.height = '24px';
      presetButton.style.margin = '2px';
      presetButton.onclick = function() {
        // When preset is clicked, store it, highlight and bold text, then remove picker
        chrome.storage.local.set({highlightColor: color}, () => {
          highlightAndBoldWord(selectedText, color);
          colorPickerContainer.remove(); // Remove picker after selection
        });
      };
      colorPickerContainer.appendChild(presetButton);
    });

    document.body.appendChild(colorPickerContainer);
  }
});

function highlightAndBoldWord(word, color) {
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
          highlight.style.fontWeight = 'bold'; // Make text bold
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
