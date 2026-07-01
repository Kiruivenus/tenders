document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const tenderForm = document.getElementById('tender-form');
    const fileInput = document.getElementById('tender_file');
    const fileDropzone = document.getElementById('file-dropzone');
    const selectedFilename = document.getElementById('selected-filename');
    
    const submitBtn = document.getElementById('btn-submit');
    const submitSpinner = document.getElementById('submit-spinner');
    const submitBtnText = submitBtn.querySelector('.btn-text');
    
    const globalError = document.getElementById('global-error');
    const globalErrorText = document.getElementById('global-error-text');
    
    const formPanel = document.getElementById('form-panel');
    const successPanel = document.getElementById('success-panel');
    const btnSubmitAnother = document.getElementById('btn-submit-another');
    
    // Success Summary Displays
    const displayEmail = document.getElementById('success-email-display');
    const summaryTitle = document.getElementById('summary-title');
    const summaryRef = document.getElementById('summary-ref');
    const summaryCategory = document.getElementById('summary-category');
    const summaryDeadline = document.getElementById('summary-deadline');

    // ----------------------------------------------------
    // Drag and Drop File Upload Event Handlers
    // ----------------------------------------------------
    ['dragenter', 'dragover'].forEach(eventName => {
        fileDropzone.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
            fileDropzone.classList.add('dragover');
        }, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        fileDropzone.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
            fileDropzone.classList.remove('dragover');
        }, false);
    });

    fileDropzone.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        const files = dt.files;
        
        if (files.length > 0) {
            fileInput.files = files;
            updateFileLabel(files[0]);
            validateField(fileInput); // Re-run validation on change
        }
    });

    fileInput.addEventListener('change', (e) => {
        if (fileInput.files.length > 0) {
            updateFileLabel(fileInput.files[0]);
            validateField(fileInput); // Re-run validation on change
        } else {
            selectedFilename.textContent = 'No file selected';
        }
    });

    function updateFileLabel(file) {
        selectedFilename.textContent = `${file.name} (${(file.size / (1024 * 1024)).toFixed(2)} MB)`;
    }

    // ----------------------------------------------------
    // Validation Helpers
    // ----------------------------------------------------
    function showError(inputEl, message) {
        // Add error class to the input element or its wrapper container
        let targetEl = inputEl;
        if (inputEl.id === 'tender_file') {
            targetEl = fileDropzone;
        }
        targetEl.classList.add('field-error');
        
        const errorEl = document.getElementById(`error-${inputEl.name || inputEl.id}`);
        if (errorEl) {
            errorEl.textContent = message;
        }
    }

    function clearError(inputEl) {
        let targetEl = inputEl;
        if (inputEl.id === 'tender_file') {
            targetEl = fileDropzone;
        }
        targetEl.classList.remove('field-error');
        
        const errorEl = document.getElementById(`error-${inputEl.name || inputEl.id}`);
        if (errorEl) {
            errorEl.textContent = '';
        }
    }

    function validateField(input) {
        const value = input.value.trim();
        const id = input.id;

        // Clear previous error
        clearError(input);

        // Required Check
        if (input.hasAttribute('required') && !value && input.type !== 'file' && input.type !== 'radio') {
            showError(input, 'This field is required.');
            return false;
        }

        // Field Specific Validations
        if (id === 'fullname' && value.length < 3) {
            showError(input, 'Please enter your full name (minimum 3 characters).');
            return false;
        }

        if (id === 'company' && value.length < 2) {
            showError(input, 'Please enter a valid company name.');
            return false;
        }

        if (id === 'email') {
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(value)) {
                showError(input, 'Please enter a valid email address (e.g. name@domain.com).');
                return false;
            }
        }

        if (id === 'phone') {
            const phoneClean = value.replace(/[^0-9+()-\s]/g, '');
            if (phoneClean.length < 7) {
                showError(input, 'Please enter a valid phone number (minimum 7 digits).');
                return false;
            }
        }

        if (id === 'title' && value.length < 8) {
            showError(input, 'Tender title should be at least 8 characters long.');
            return false;
        }

        if (id === 'category' && !value) {
            showError(input, 'Please select a tender category.');
            return false;
        }

        if (id === 'deadline') {
            const selectedDate = new Date(value);
            const today = new Date();
            today.setHours(0, 0, 0, 0); // Reset time for accurate date comparison
            
            if (isNaN(selectedDate.getTime())) {
                showError(input, 'Please select a valid deadline date.');
                return false;
            }
            if (selectedDate < today) {
                showError(input, 'The deadline cannot be in the past.');
                return false;
            }
        }

        if (id === 'description' && value.length < 30) {
            showError(input, 'Please provide a more detailed description (minimum 30 characters).');
            return false;
        }

        if (id === 'tender_file') {
            const file = input.files[0];
            if (!file) {
                showError(input, 'Please upload your tender proposal document.');
                return false;
            }
            
            // Check file type
            const allowedExtensions = /(\.pdf|\.docx)$/i;
            if (!allowedExtensions.exec(file.name)) {
                showError(input, 'Unsupported file format. Only PDF and DOCX files are allowed.');
                return false;
            }
            
            // Check file size (10MB max)
            const maxSize = 10 * 1024 * 1024; // 10MB
            if (file.size > maxSize) {
                showError(input, 'The file size exceeds the 10MB limit. Please compress your document.');
                return false;
            }
        }

        return true;
    }

    // Live validation feedback on blur
    const formFields = tenderForm.querySelectorAll('input:not([type="radio"]), select, textarea');
    formFields.forEach(field => {
        field.addEventListener('blur', () => validateField(field));
    });

    // Generate readable receipt reference ID
    function generateRefCode() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let randStr = '';
        for (let i = 0; i < 6; i++) {
            randStr += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return `APX-2026-${randStr}`;
    }

    // ----------------------------------------------------
    // Form Submission Handling
    // ----------------------------------------------------
    tenderForm.addEventListener('submit', (e) => {
        e.preventDefault();
        globalError.classList.add('hidden');

        // Validate all fields
        let isValid = true;
        let firstInvalidField = null;

        formFields.forEach(field => {
            const fieldValid = validateField(field);
            if (!fieldValid) {
                isValid = false;
                if (!firstInvalidField) {
                    firstInvalidField = field;
                }
            }
        });

        if (!isValid) {
            if (firstInvalidField) {
                firstInvalidField.focus();
            }
            return;
        }

        // Set Loading State UI
        submitBtn.disabled = true;
        submitSpinner.classList.remove('hidden');
        submitBtnText.textContent = 'Submitting Proposal...';

        // Prepare Form Data payload
        const formData = new FormData(tenderForm);

        // Determine the API endpoint URL dynamically.
        // If the frontend is hosted on a static port (e.g. Live Server on 5500), forward requests to the Express port (3000).
        const endpoint = window.location.port && window.location.port !== '3000'
            ? 'http://localhost:3000/submit-tender'
            : '/submit-tender';

        // Perform Submit Fetch Request
        fetch(endpoint, {
            method: 'POST',
            body: formData
        })
        .then(async response => {
            // First check response status
            if (!response.ok) {
                let errMsg = `Server returned status code ${response.status}.`;
                try {
                    const errorJson = await response.json();
                    if (errorJson && errorJson.message) {
                        errMsg = errorJson.message;
                    }
                } catch(e) {}
                throw new Error(errMsg);
            }
            return response.json();
        })
        .then(data => {
            // Success response handling
            displayEmail.textContent = formData.get('email');
            summaryTitle.textContent = formData.get('title');
            summaryCategory.textContent = formData.get('category');
            summaryDeadline.textContent = formData.get('deadline');
            summaryRef.textContent = data.reference || generateRefCode();

            // Transition to Success panel
            formPanel.classList.add('hidden');
            successPanel.classList.remove('hidden');
            
            // Scroll to the top of success card
            successPanel.scrollIntoView({ behavior: 'smooth' });
        })
        .catch(error => {
            console.error('Submission Error:', error);
            globalErrorText.textContent = `Submission failed: ${error.message || 'Please check your connection and try again.'}`;
            globalError.classList.remove('hidden');
            globalError.scrollIntoView({ behavior: 'smooth' });
        })
        .finally(() => {
            // Reset Loading State UI
            submitBtn.disabled = false;
            submitSpinner.classList.add('hidden');
            submitBtnText.textContent = 'Submit Proposal';
        });
    });

    // ----------------------------------------------------
    // Reset / Submit Another Proposal Action
    // ----------------------------------------------------
    btnSubmitAnother.addEventListener('click', () => {
        // Reset form inputs
        tenderForm.reset();
        selectedFilename.textContent = 'No file selected';
        
        // Clear validation styles
        formFields.forEach(field => {
            clearError(field);
        });
        globalError.classList.add('hidden');

        // Transition back to form
        successPanel.classList.add('hidden');
        formPanel.classList.remove('hidden');
        
        // Scroll to form header
        formPanel.scrollIntoView({ behavior: 'smooth' });
    });
});
