const puppeteer = require('puppeteer-extra');
const stealth_plugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

puppeteer.use(stealth_plugin());

function sanitize_domain_name(domain) {
    return domain.replace(/[^a-zA-Z0-9]/g, '_');
}


function get_base_domain(url_string) {
    try {
        const hostname = new URL(url_string).hostname;
        return hostname.replace(/^www\./, '');
    } catch {
        console.log(`Erro getting base domain for ${url_string} (??)`)
        return '';
    }
}


async function process_domain(domain) {
    console.log(`\n--- Processing ${domain} ---`);

    const url = domain.startsWith('http') ? domain : `https://${domain}`;
    const sanitized_name = sanitize_domain_name(domain);
    const output_directory = path.join(__dirname, sanitized_name);

    if (!fs.existsSync(output_directory)) {
        fs.mkdirSync(output_directory, { recursive: true });
    }

    let page;
    let browser;

    try {
        browser = await puppeteer.launch({
            headless: false,
            devtools: false,
            executablePath: '/usr/bin/google-chrome',
            args: [
                '--disable-features=VizDisplayCompositor',
                '--start-maximized'
            ],
            defaultViewport: null //{ width: 1280, height: 800 }
        });

        page = await browser.newPage();

        console.log(`Visiting ${url}...`);

        await page.goto(url, {
            waitUntil: ['networkidle2', 'domcontentloaded'],
            timeout: 30000
        });

        console.log('Network idle reached, waiting 30 seconds for remaining activity...');
        await new Promise(resolve => setTimeout(resolve, 30000));

        const full_html = await page.content();

        const output_filepath = path.join(output_directory, `${sanitized_name}.html`);
        fs.writeFileSync(output_filepath, full_html, 'utf-8');

        console.log(`Saved HTML (${full_html.length} bytes) to ${output_filepath}`);

        return { success: true, domain: domain, filepath: output_filepath };

    } catch (error) {
        console.error(`Error processing ${domain}:`, error.message);
        return { success: false, domain: domain, error: error.message };

    } finally {
        if (page) {
            try { await page.close(); } catch (close_error) {
                console.error(`Error closing page for ${domain}:`, close_error.message);
            }
        }
        if (browser) {
            try { await browser.close(); } catch (close_error) {
                console.error(`Error closing browser for ${domain}:`, close_error.message);
            }
        }
    }
}

async function main() {
    const domains_file = path.join(__dirname, 'domains.txt');

    if (!fs.existsSync(domains_file)) {
        console.error('domains.txt not found');
        process.exit(1);
    }

    const raw_content = fs.readFileSync(domains_file, 'utf-8');
    const domains = raw_content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('#'));

    console.log(`Loaded ${domains.length} domains from domains.txt`);

    const results = { successful: [], failed: [] };

    for (const domain of domains) {
        const result = await process_domain(domain);

        if (result.success) {
            results.successful.push(result.domain);
        } else {
            results.failed.push({ domain: result.domain, error: result.error });
        }
    }

    console.log(`Successfully crawled: ${results.successful.length} domains`);
    console.log(`Failed: ${results.failed.length}`);







    
    if (results.failed.length > 0) {
        console.log('Failed domains:');
        for (const failure of results.failed) {
            console.log(`  ${failure.domain}: ${failure.error}`);
        }
    }
}

main();