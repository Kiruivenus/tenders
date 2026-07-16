document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const tenderForm = document.getElementById('tender-form');
    
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

    const summaryRef = document.getElementById('summary-ref');
    const summaryCategory = document.getElementById('summary-category');

    // ----------------------------------------------------
    // Validation Helpers
    // ----------------------------------------------------
    function showError(inputEl, message) {
        inputEl.classList.add('field-error');
        
        const errorEl = document.getElementById(`error-${inputEl.name || inputEl.id}`);
        if (errorEl) {
            errorEl.textContent = message;
        }
    }

    function clearError(inputEl) {
        inputEl.classList.remove('field-error');
        
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
        if (input.hasAttribute('required') && !value) {
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



        if (id === 'description' && value.length < 30) {
            showError(input, 'Please provide a more detailed description (minimum 30 characters).');
            return false;
        }

        return true;
    }

    function validateCategoryGroup() {
        const checkedBoxes = Array.from(tenderForm.querySelectorAll('input[name="category"]:checked'));
        const errorEl = document.getElementById('error-category');
        const gridEl = document.getElementById('category-grid');
        
        if (checkedBoxes.length === 0) {
            gridEl.classList.add('field-error');
            if (errorEl) {
                errorEl.textContent = 'Please select at least one category.';
            }
            return false;
        } else {
            gridEl.classList.remove('field-error');
            if (errorEl) {
                errorEl.textContent = '';
            }
            return true;
        }
    }

    // Live validation feedback on blur
    const formFields = tenderForm.querySelectorAll('input:not([type="radio"]):not([type="checkbox"]), select, textarea');
    formFields.forEach(field => {
        field.addEventListener('blur', () => validateField(field));
    });

    // Bind change listeners to category checkboxes for real-time validation feedback
    const categoryCheckboxes = tenderForm.querySelectorAll('input[name="category"]');
    categoryCheckboxes.forEach(checkbox => {
        checkbox.addEventListener('change', () => validateCategoryGroup());
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

        // Validate category checkbox group
        const isCategoryValid = validateCategoryGroup();
        if (!isCategoryValid) {
            isValid = false;
            if (!firstInvalidField) {
                firstInvalidField = document.getElementById('category-grid');
            }
        }

        if (!isValid) {
            if (firstInvalidField) {
                firstInvalidField.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
        let endpoint = '/submit-tender';
        if (window.location.port && window.location.port !== '3000') {
            endpoint = 'http://localhost:3000/submit-tender';
        } else {
            // Resolve path relative to current URL directory to support subfolder deployments on cPanel
            const pathParts = window.location.pathname.split('/');
            if (pathParts[pathParts.length - 1].includes('.') || pathParts[pathParts.length - 1] === '') {
                pathParts.pop();
            }
            let basePath = pathParts.join('/');
            if (!basePath.endsWith('/')) {
                basePath += '/';
            }
            endpoint = basePath + 'submit-tender';
        }

        // Perform Submit Fetch Request
        fetch(endpoint, {
            method: 'POST',
            body: formData
        })
        .then(async response => {
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

            
            // Join checked categories as comma-separated string
            const checkedCats = Array.from(tenderForm.querySelectorAll('input[name="category"]:checked'))
                                     .map(cb => cb.value);
            summaryCategory.textContent = checkedCats.join(', ');
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
        
        // Clear validation styles
        formFields.forEach(field => {
            clearError(field);
        });
        
        document.getElementById('category-grid').classList.remove('field-error');
        const categoryError = document.getElementById('error-category');
        if (categoryError) {
            categoryError.textContent = '';
        }
        
        globalError.classList.add('hidden');

        // Transition back to form
        successPanel.classList.add('hidden');
        formPanel.classList.remove('hidden');
        
        // Scroll to form header
        formPanel.scrollIntoView({ behavior: 'smooth' });
    });
});
