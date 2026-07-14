document.addEventListener('DOMContentLoaded', () => {
    const requestForm = document.getElementById('request-form');
    const applicantName = document.getElementById('applicant_name');
    const companyName = document.getElementById('company_name');
    const emailAddress = document.getElementById('email_address');
    const phoneNumber = document.getElementById('phone_number');
    const tenderTitle = document.getElementById('tender_title');
    const tenderCategory = document.getElementById('tender_category');
    const tenderDescription = document.getElementById('tender_description');
    
    const previewSubject = document.getElementById('preview-subject');
    const previewBody = document.getElementById('preview-body');
    const btnOpenEmail = document.getElementById('btn-open-email');
    const statusMessage = document.getElementById('status-message');

    // Validation patterns
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    // Track state of required inputs
    const fields = [
        { el: applicantName, id: 'applicant_name', req: true },
        { el: companyName, id: 'company_name', req: true },
        { el: emailAddress, id: 'email_address', req: true, val: (val) => emailRegex.test(val), errText: 'Please enter a valid email address.' },
        { el: phoneNumber, id: 'phone_number', req: false },
        { el: tenderTitle, id: 'tender_title', req: true },
        { el: tenderCategory, id: 'tender_category', req: true },
        { el: tenderDescription, id: 'tender_description', req: true }
    ];

    function validateForm() {
        let isFormValid = true;
        
        fields.forEach(field => {
            const val = field.el.value.trim();
            
            // Check required inputs
            if (field.req && !val) {
                isFormValid = false;
            } 
            // Check custom validation (e.g., email format)
            else if (val && field.val && !field.val(val)) {
                isFormValid = false;
            }
        });

        btnOpenEmail.disabled = !isFormValid;
        return isFormValid;
    }

    function updatePreview() {
        const nameVal = applicantName.value.trim() || '[Applicant Name]';
        const companyVal = companyName.value.trim() || '[Company]';
        const emailVal = emailAddress.value.trim() || '[Applicant Email]';
        const phoneVal = phoneNumber.value.trim() || '[Phone]';
        const titleVal = tenderTitle.value.trim() || '[Tender Title]';
        const categoryVal = tenderCategory.value || '[Tender Category]';
        const descVal = tenderDescription.value.trim() || '[Description]';

        previewSubject.textContent = `Request for Tender Application Form – ${tenderTitle.value.trim() || '[Tender Title]'}`;
        
        const bodyContent = `Dear Dola Group Procurement Team,

I would like to request the official tender application form for the following tender.

Tender Title:
${titleVal}

Category:
${categoryVal}

Applicant:
${nameVal}

Company:
${companyVal}

Email:
${emailVal}

Phone:
${phoneVal || 'Not provided'}

Description:
${descVal}

Kindly send me the official application form together with any relevant tender documentation.

Thank you.

Kind regards,

${nameVal}`;

        previewBody.textContent = bodyContent;
        return bodyContent;
    }

    // Bind real-time inputs
    fields.forEach(field => {
        field.el.addEventListener('input', () => {
            const val = field.el.value.trim();
            const errEl = document.getElementById(`error-${field.id}`);
            
            if (field.req && !val) {
                errEl.textContent = 'This field is required.';
                field.el.classList.add('invalid');
            } else if (val && field.val && !field.val(val)) {
                errEl.textContent = field.errText;
                field.el.classList.add('invalid');
            } else {
                errEl.textContent = '';
                field.el.classList.remove('invalid');
            }
            
            validateForm();
            updatePreview();
        });
        
        if (field.el.tagName === 'SELECT') {
            field.el.addEventListener('change', () => {
                validateForm();
                updatePreview();
            });
        }
    });

    // Handle form submit and launch default client
    requestForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        if (!validateForm()) return;

        const btnText = document.getElementById('btn-text');
        btnOpenEmail.disabled = true;
        btnText.innerHTML = '<span class="loader"></span> Preparing Email App...';
        
        // 800ms loading duration for user feedback
        await new Promise(resolve => setTimeout(resolve, 800));

        try {
            const subject = `Request for Tender Application Form – ${tenderTitle.value.trim()}`;
            const body = updatePreview();
            const mailtoUrl = `mailto:tenders@dolagroup.info?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
            
            // Open user's default app
            window.location.href = mailtoUrl;

            showStatus('success', 'Your default email client has been launched successfully. Please review the populated draft and click send.');
        } catch (err) {
            showStatus('error', 'Unable to open email client automatically. Please copy the details above and email tenders@dolagroup.info directly.');
        } finally {
            btnText.innerHTML = 'Open Email App';
            validateForm();
        }
    });

    function showStatus(type, msg) {
        statusMessage.className = '';
        statusMessage.style.display = 'block';
        
        if (type === 'success') {
            statusMessage.style.backgroundColor = 'var(--color-success-bg)';
            statusMessage.style.borderColor = 'var(--color-success-border)';
            statusMessage.style.color = 'var(--color-success)';
        } else {
            statusMessage.style.backgroundColor = 'var(--color-error-bg)';
            statusMessage.style.borderColor = 'var(--color-error-border)';
            statusMessage.style.color = 'var(--color-error)';
        }
        
        statusMessage.style.padding = '12px 16px';
        statusMessage.style.borderRadius = 'var(--border-radius)';
        statusMessage.style.borderStyle = 'solid';
        statusMessage.style.borderWidth = '1px';
        statusMessage.style.marginBottom = '20px';
        statusMessage.style.fontSize = '0.9rem';
        statusMessage.style.fontWeight = '500';
        statusMessage.textContent = msg;
        statusMessage.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
});
