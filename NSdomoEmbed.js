/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 */
define(['N/https', 'N/encode', 'N/log'], function(https, encode, log) {
    
    /**
     * Domo API Configuration
     */
    const DOMO_CONFIG = {
        clientId: 'add client id here',
        clientSecret: 'add client secret here',
        embedId: 'add embed id here',
        embedType: 'dashboard',
        inlineHtmlFieldId: 'custentitydecustomerdashboar',
        sessionLength: 1440,
        permissions: ['READ', 'FILTER', 'EXPORT'],
        filterColumn: 'Account.Id',
        filterOperator: 'IN',
        customerIdFieldId: 'externalid'
    };
    
    const DOMO_ENDPOINTS = {
        token: 'https://api.domo.com/oauth/token?grant_type=client_credentials&scope=data%20audit%20user%20dashboard',
        embedAuth: {
            dashboard: 'https://api.domo.com/v1/stories/embed/auth',
            card: 'https://api.domo.com/v1/cards/embed/auth'
        }
    };


    /**
     * Authenticate with Domo API and get access token
     * @returns {Promise<string>} access token
     */
    async function getDomoAccessToken() {
        try {
            const credentials = DOMO_CONFIG.clientId + ':' + DOMO_CONFIG.clientSecret;
            
            // Use NetSuite N/encode module for Base64 encoding
            const encodedCredentials = encode.convert({
                string: credentials,
                inputEncoding: encode.Encoding.UTF_8,
                outputEncoding: encode.Encoding.BASE_64
            });
            const authHeader = 'Basic ' + encodedCredentials;
            
            const response = https.post({
                url: DOMO_ENDPOINTS.token,
                headers: {
                    'Authorization': authHeader,
                    'Accept': 'application/json',
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            });
            
            if (response.code !== 200) {
                log.error('Domo Auth Error', {
                    status: response.code,
                    body: response.body
                });
                throw new Error(`Domo Auth Error: ${response.code} - ${response.body}`);
            }
            
            const responseBody = JSON.parse(response.body);
            return responseBody.access_token;
            
        } catch (e) {
            log.error('Domo Authentication Error', e.toString());
            throw e;
        }
    }

    /**
     * Get embed authentication token from Domo
     * @param {string} accessToken - Domo access token
     * @param {string} customerId - Customer ID for filtering (optional)
     * @returns {Promise<string>} embed token
     */
    async function getDomoEmbedToken(accessToken, customerId) {
        try {
            const embedEndpoint = DOMO_CONFIG.embedType === 'card' 
                ? DOMO_ENDPOINTS.embedAuth.card 
                : DOMO_ENDPOINTS.embedAuth.dashboard;
            
            const payload = {
                sessionLength: DOMO_CONFIG.sessionLength,
                authorizations: [{
                    token: DOMO_CONFIG.embedId,
                    permissions: DOMO_CONFIG.permissions,
                    filters: customerId ? [{
                        column: DOMO_CONFIG.filterColumn,
                        operator: DOMO_CONFIG.filterOperator,
                        values: [customerId]
                    }] : []
                }]
            };
            
            const response = https.post({
                url: embedEndpoint,
                body: JSON.stringify(payload),
                headers: {
                    'Authorization': 'bearer ' + accessToken,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                }
            });
            
            if (response.code !== 200) {
                log.error('Domo Embed Auth Error', {
                    status: response.code,
                    body: response.body
                });
                throw new Error(`Domo Embed Auth Error: ${response.code} - ${response.body}`);
            }
            
            const responseBody = JSON.parse(response.body);
            
            if (!responseBody.authentication) {
                log.error('No authentication key found in embed response', responseBody);
                throw new Error('No authentication token found in Domo embed response');
            }
            
            return responseBody.authentication;
            
        } catch (e) {
            log.error('Domo Embed Token Error', e.toString());
            throw e;
        }
    }

    /**
     * Generate HTML for embedding Domo dashboard/card
     * @param {string} embedToken - Domo embed token
     * @returns {string} HTML content
     */
    function generateDomoEmbedHTML(embedToken) {
        if (!embedToken || embedToken.trim() === '') {
            log.error('Invalid embedToken passed to generateDomoEmbedHTML', embedToken);
            return '<div>Error: Invalid embed token</div>';
        }
        
        const embedUrl = DOMO_CONFIG.embedType === 'card' 
            ? `https://public.domo.com/cards/${DOMO_CONFIG.embedId}`
            : `https://public.domo.com/embed/pages/${DOMO_CONFIG.embedId}`;
        
        return `
            <div id="domo-embed-container" style="width: 100%; height: 600px; border: none; margin: 0; padding: 0; overflow: hidden;">
                <iframe id="domo-iframe" 
                        name="domo-iframe"
                        src="about:blank"
                        style="width: 100vw; height: 100vh; border: none; outline: none; margin: 0; padding: 0; display: block;"
                        frameborder="0"
                        scrolling="auto"
                        allowfullscreen>
                </iframe>
            </div>
            <script>
                document.addEventListener('DOMContentLoaded', function() {
                    var iframe = document.getElementById('domo-iframe');
                    if (iframe) {
                        var form = document.createElement('form');
                        form.method = 'POST';
                        form.action = '${embedUrl}';
                        form.target = 'domo-iframe';
                        form.style.display = 'none';
                        form.setAttribute('enctype', 'application/x-www-form-urlencoded');
                        
                        var tokenField = document.createElement('input');
                        tokenField.type = 'hidden';
                        tokenField.name = 'embedToken';
                        tokenField.value = '${embedToken.replace(/'/g, "\\'")}';
                        form.appendChild(tokenField);
                        
                        document.body.appendChild(form);
                        form.submit();
                        
                        setTimeout(function() {
                            if (form && form.parentNode) {
                                form.parentNode.removeChild(form);
                            }
                        }, 2000);
                    }
                });
            </script>
        `;
    }

    /**
     * Before Load Event Handler
     * This runs when the record is loaded and we can modify the form
     */
    async function beforeLoad(scriptContext) {
        const form = scriptContext.form;
        const record = scriptContext.newRecord;
        
        if (record.type !== 'customer') {
            return;
        }
        
        try {
            // Get the customer external ID for filtering
            const customerId = record.getValue({
                fieldId: DOMO_CONFIG.customerIdFieldId
            });
            
            const accessToken = await getDomoAccessToken();
            if (!accessToken) {
                log.error('Failed to get Domo access token');
                return;
            }
            
            const embedToken = await getDomoEmbedToken(accessToken, customerId);
            if (!embedToken) {
                log.error('Failed to get Domo embed token');
                return;
            }
            
            const embedHTML = generateDomoEmbedHTML(embedToken);
            
            const inlineHtmlField = form.getField({
                id: DOMO_CONFIG.inlineHtmlFieldId
            });
            
            if (inlineHtmlField) {
                inlineHtmlField.defaultValue = embedHTML;
                inlineHtmlField.isDisplay = true;
            } else {
                log.error('Inline HTML field not found: ' + DOMO_CONFIG.inlineHtmlFieldId);
            }
            
        } catch (e) {
            log.error('Error in beforeLoad', e.toString());
        }
    }

    return {
        beforeLoad: beforeLoad
    };
});
