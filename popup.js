// On popup load, set the color picker to the last selected color
document.addEventListener('DOMContentLoaded', function() {
  chrome.storage.local.get(['highlightColor'], function(result) {
    if (result.highlightColor) {
      document.getElementById('colorPicker').value = result.highlightColor;
    }
  });
  
  // Define your preset colors
  const presets = ['#FF5733', '#33FF57', '#3357FF', '#F333FF', '#FF3357'];
  const presetsContainer = document.getElementById('colorPresets');
  
  // Create buttons for each preset color
  presets.forEach(color => {
    const button = document.createElement('button');
    button.style.backgroundColor = color;
    button.style.width = '24px';
    button.style.height = '24px';
    button.style.border = '1px solid #000';
    button.style.marginRight = '5px';
    button.setAttribute('title', color);
    button.onclick = function() {
      chrome.storage.local.set({highlightColor: color});
      document.getElementById('colorPicker').value = color;
    };
    presetsContainer.appendChild(button);
  });
});