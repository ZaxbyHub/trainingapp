# Security Hardening Guide for Production

This guide provides comprehensive security documentation for deploying the Document Q&A Assistant in production environments.

---

## Pre-Deployment Checklist

Before deploying to production, complete the following security checks:

### Authentication & Access
- [ ] Set `ENABLE_AUTH=true` environment variable
- [ ] Generate strong API key: `openssl rand -hex 32` (Linux/macOS) or `openssl rand -hex 32` (Windows)
- [ ] Set `API_KEY` environment variable with the generated key
- [ ] Set `JWT_SECRET` environment variable: `openssl rand -hex 64`
- [ ] Set `JWT_EXPIRATION_HOURS` (recommended: 24)

### Network Security
- [ ] Configure firewall to restrict port 8080 access
- [ ] Enable HTTPS using a reverse proxy (nginx/Apache)
- [ ] Test SSL certificate chain and expiration
- [ ] Block all non-essential ports at the firewall

### File Upload Security
- [ ] Set `RAG_MAX_FILE_SIZE` (recommended: 50MB)
- [ ] Document allowed file types: PDF, DOCX, PPTX, TXT, MD
- [ ] Configure file scanning if required by organizational policy

### Monitoring & Logging
- [ ] Enable debug mode only in development (set `DEBUG=false` in production)
- [ ] Configure log aggregation (e.g., ELK, Splunk)
- [ ] Set up audit logging for API endpoints
- [ ] Configure suspicious activity alerts

### Environment Security
- [ ] Store all environment variables securely (don't commit to version control)
- [ ] Use separate keys for development, staging, and production
- [ ] Rotate API keys and JWT secrets regularly (recommended: every 90 days)
- [ ] Disable debug mode before production deployment

---

## Environment Variables

### Required for Production

| Variable | Description | Generation Command | Security Note |
|----------|-------------|-------------------|---------------|
| `ENABLE_AUTH` | Enable authentication (set to `true`) | N/A | **MUST be `true`** for production |
| `API_KEY` | API key for authentication | `openssl rand -hex 32` | Store in environment, never in code |
| `JWT_SECRET` | Secret for JWT token signing | `openssl rand -hex 64` | Use strong random generation |
| `RAG_MAX_FILE_SIZE` | Max upload size in MB | N/A (default: 50) | Limit based on org policy |

### Recommended

| Variable | Description | Recommended Value | Default |
|----------|-------------|------------------|---------|
| `JWT_EXPIRATION_HOURS` | Token lifetime | `24` | `24` |
| `RAG_MIN_SIMILARITY` | Strict similarity threshold | `0.5` | `0.3` |
| `RAG_N_RESULTS` | Reduced context chunks | `2` | `3` |
| `RAG_CONTEXT_TRUNCATION` | Context token limit | `6000` | `6000` |

### Example: Production Environment Setup

#### Linux/macOS
```bash
# Generate secure keys
export API_KEY="$(openssl rand -hex 32)"
export JWT_SECRET="$(openssl rand -hex 64)"

# Set production config
export ENABLE_AUTH=true
export RAG_MAX_FILE_SIZE="50"
export JWT_EXPIRATION_HOURS="24"

# Start application
python main.py --api --port 8080
```

#### Windows (PowerShell)
```powershell
# Generate secure keys
$env:API_KEY = (-join ((48..57) + (97..102) | Get-Random -Count 64 | ForEach-Object {[char]$_}))
$env:JWT_SECRET = (-join ((48..57) + (97..102) | Get-Random -Count 128 | ForEach-Object {[char]$_}))

# Set production config
$env:ENABLE_AUTH = "true"
$env:RAG_MAX_FILE_SIZE = "50"
$env:JWT_EXPIRATION_HOURS = "24"

# Start application
python main.py --api --port 8080
```

---

## Authentication Setup

The application supports two authentication methods:

### JWT Bearer Tokens
- For programmatic API access
- Suitable for server-to-server communication
- Supports configurable expiration

### API Key Header
- For simple authentication (e.g., tkinter GUI)
- Uses constant-time comparison to prevent timing attacks

### Generating Secure Keys

#### Linux/macOS
```bash
# API Key (32 bytes = 64 hex chars)
openssl rand -hex 32

# JWT Secret (64 bytes = 128 hex chars)
openssl rand -hex 64

# Generate secure password (base64)
openssl rand -base64 32
```

#### Windows (PowerShell)
```powershell
# API Key (32 bytes = 64 hex chars)
-join ((48..57) + (97..102) | Get-Random -Count 64 | ForEach-Object {[char]$_})

# JWT Secret (64 bytes = 128 hex chars)
-join ((48..57) + (97..102) | Get-Random -Count 128 | ForEach-Object {[char]$_})
```

### Using Authentication

With authentication enabled, include the appropriate header in all API requests:

```bash
# Using API Key
curl -X POST http://localhost:8080/ask \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key-here" \
  -d '{"question": "What is RAG?"}'

# Using JWT Token
curl -X POST http://localhost:8080/ask \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <jwt-token>" \
  -d '{"question": "What is RAG?"}'
```

---

## Network Security

### Firewall Configuration

Restrict incoming connections to only necessary ports:

#### Linux (ufw)
```bash
# Allow only API server port
sudo ufw allow 8080/tcp

# Enable firewall
sudo ufw enable

# Check status
sudo ufw status
```

#### Windows (PowerShell)
```powershell
# Allow only API server port
New-NetFirewallRule -DisplayName "Allow Doc Q&A API" -Direction Inbound -LocalPort 8080 -Protocol TCP -Action Allow

# Block all other inbound
Set-NetFirewallProfile -Profile Domain,Private,Public -DefaultInboundAction Block
```

### HTTPS Setup with nginx Reverse Proxy

Configure nginx to terminate TLS and proxy to the application:

#### nginx Configuration (`/etc/nginx/sites-available/doc-qna`)
```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.com;

    # SSL Certificate Configuration
    ssl_certificate /etc/ssl/certs/your-cert.pem;
    ssl_certificate_key /etc/ssl/private/your-key.pem;
    
    # Strong SSL Configuration
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256;
    ssl_prefer_server_ciphers on;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;

    # Proxy to API server
    location / {
        proxy_pass http://localhost:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # Timeouts
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    # Security Headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
}
```

#### Enable the Site
```bash
# Create symlink
sudo ln -s /etc/nginx/sites-available/doc-qna /etc/nginx/sites-enabled/

# Test configuration
sudo nginx -t

# Reload nginx
sudo systemctl reload nginx
```

---

## Input Validation

### File Upload Limits

The application enforces the following restrictions:

- **Maximum File Size**: 50MB (configurable via `RAG_MAX_FILE_SIZE`)
- **Error Response**: HTTP 413 (Payload Too Large) for oversized files

### Allowed File Types

Only the following file extensions are permitted:
- `.pdf` - PDF documents
- `.docx` - Microsoft Word (OOXML)
- `.doc` - Microsoft Word (legacy)
- `.pptx` - Microsoft PowerPoint (OOXML)
- `.ppt` - Microsoft PowerPoint (legacy)
- `.txt` - Plain text
- `.md` - Markdown

Attempting to upload unsupported file types results in HTTP 400 (Bad Request).

### File Sanitization

All uploaded files are:
1. Validated for extension matching
2. Stored in temporary files with sanitized names
3. Processed in isolated temporary directories
4. Deleted after processing

---

## Security Features

### SSRF Protection
- **Location**: `security.py` - `validate_url()` function
- **Mechanism**: Validates all URLs against:
  - Localhost and loopback addresses (blocked unless explicitly allowed)
  - Private IP ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
  - Link-local addresses (169.254.0.0/16)
  - Reserved address ranges
- **Context**: Strict mode for API server, permissive mode for local LLM

### Path Traversal Protection
- **Location**: `api_server.py` - `validate_directory()` function
- **Mechanism**: 
  - Resolves symlinks and validates target is within allowed base directory
  - Rejects paths containing `..` sequences
  - Validates resolved paths against base directory
- **Symlink Protection**: Checks each path component for symlink escapes

### Authentication
- **Location**: `auth.py`
- **Methods**:
  - JWT Bearer tokens (programmatic access)
  - API Key headers (GUI clients)
- **Timing Attack Prevention**: Uses `secrets.compare_digest()` for constant-time key comparison
- **Configurable**: Can be disabled via `ENABLE_AUTH=false` (development only)

### Input Sanitization
- **Filename Sanitization**: Removes dangerous characters from uploaded files
- **URL Validation**: SSRF protection for all external URLs
- **Error Messages**: Sanitized to prevent information disclosure

---

## Monitoring and Logging

### Audit Logging Recommendations

Track the following security-relevant events:

| Event | Log Level | Description |
|-------|-----------|-------------|
| Authentication failures | WARNING | Failed login attempts |
| Rate limiting triggers | INFO | Potential brute force |
| File upload errors | WARNING | Suspicious file types/sizes |
| API key rotation | INFO | Security best practice |
| SSRF/path traversal attempts | CRITICAL | Attack attempts |

### Suspicious Activity Monitoring

Implement monitoring for:

1. **Failed Authentication Attempts**
   - Threshold: >5 failures per minute from single IP
   - Action: Temporarily block IP, alert security team

2. **Unusual File Uploads**
   - Large files (approaching limit)
   - Unexpected file types
   - Multiple rapid uploads from single user

3. **API Key Usage Patterns**
   - Unused keys (may indicate compromise)
   - Keys used from multiple geographic locations
   - Sudden change in usage volume

### Logging Configuration Example

```python
import logging
import os

# Production logging configuration
logging.basicConfig(
    level=logging.INFO,  # CRITICAL for security events
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler(os.environ.get('LOG_FILE', 'security.log')),
        logging.StreamHandler()
    ]
)
```

---

## Incident Response

### Authentication Bypass Response

**Symptoms**:
- Multiple failed login attempts from single IP
- Successful authentication after lockout
- Unusual API usage patterns

**Immediate Actions**:
1. Block suspicious IP at firewall level
2. Invalidate all active sessions
3. Rotate API keys immediately
4. Rotate JWT secret
5. Review access logs for unauthorized activity

**Recovery Steps**:
1. Identify compromised credentials
2. Notify affected users
3. Implement additional monitoring for 30 days
4. Review and update security policies

### File Upload Exploitation Response

**Symptoms**:
- Unexpected file types processed
- Large file uploads
- Binary content in text files

**Immediate Actions**:
1. Disable file upload endpoint temporarily
2. Review all uploaded files in last 24 hours
3. Scan for malicious content
4. Isulate affected systems

**Recovery Steps**:
1. Purge malware from systems
2. Restore from clean backup if necessary
3. Re-enable upload with stricter validation
4. Add additional file content inspection

### Reporting Security Issues

**Do NOT** use public issue trackers for security vulnerabilities.

Instead, contact the security team directly or use a responsible disclosure process.

---

## Security Updates

### Dependency Management

Regularly update dependencies for security patches:

```bash
# Check for vulnerable dependencies
pip audit

# Update dependencies
pip install --upgrade -r requirements.txt
```

### Security Patch Schedule

| Frequency | Task |
|-----------|------|
| Weekly | Run `pip audit` to check for vulnerabilities |
| Monthly | Update all dependencies to latest secure versions |
| Quarterly | Full security review and penetration testing |
| Immediately | Apply patches for critical vulnerabilities (CVE) |

### Security Dependencies to Monitor

- **Python**: `python-jose[cryptography]` (JWT), `cryptography`
- **Web Framework**: FastAPI (security patches)
- **Database**: ChromaDB (access control updates)
- **ML Framework**: torch, tensorflow (security patches)

---

## Compliance Notes

### Data Privacy

- **No Data Exfiltration**: All processing occurs on-premises
- **No Cloud Services**: Application is designed for air-gapped environments
- **Data Residency**: Documents never leave the host machine
- **Encryption at Rest**: Consider encrypting the vector database directory

### Audit Requirements

For regulated industries (HIPAA, GDPR, etc.):

1. **Access Logging**: Maintain detailed logs of all API access
2. ** Data Retention**: Define and enforce document retention policies
3. **Right to Erasure**: Implement procedures to remove user data
4. **Data Portability**: Export user data in standard format on request

### Recommended Security Policies

1. **API Key Rotation**: Rotate all keys every 90 days
2. **Access Reviews**: Quarterly review of API key usage
3. **Security Training**: Annual security awareness for developers
4. **Penetration Testing**: Annual external security assessment

---

## Additional Resources

### Official Documentation
- [FastAPI Security](https://fastapi.tiangolo.com/security/) - REST API security
- [Pydantic Settings](https://docs.pydantic.dev/latest/usage/settings/) - Configuration management
- [python-jose](https://github.com/mpdvis/python-jose) - JWT implementation

### Security Best Practices
- [OWASP API Security Top 10](https://owasp.org/www-project-api-security/) - API security risks
- [CIS Benchmarks](https://www.cisecurity.org/benchmark) - System hardening standards

### Tools
- [Bandit](https://bandit.readthedocs.io/) - Python security linter
- [pip-audit](https://pypi.org/project/pip-audit/) - Dependency vulnerability scanner
- [Semgrep](https://semgrep.dev/) - Code security scanning

---

## Appendix: Quick Reference

### Production Checklist Summary

1. **Authentication**: `ENABLE_AUTH=true` + valid API key/JWT secret
2. **Network**: Firewall rules + HTTPS via reverse proxy
3. **Uploads**: File size limits + allowed types only
4. **Monitoring**: Audit logs + suspicious activity alerts
5. **Updates**: Regular dependency security checks

### Emergency Commands

```bash
# Block suspicious IP (Linux)
sudo ufw deny from <IP-ADDRESS>

# View recent authentication failures
grep "Authentication" /var/log/syslog

# Check running services
ps aux | grep python
```

---

**Document Version**: 1.0.0  
**Last Updated**: 2026-04-09  
**Maintained By**: Security Team
