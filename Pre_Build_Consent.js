const puppeteer = require('puppeteer-extra');
const stealth_plugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

puppeteer.use(stealth_plugin());

process.on('unhandledRejection', (reason) => {
    if (reason && reason.name === 'TargetCloseError') {
        return;
    }
    throw reason;
});

const navigation_timeout_milliseconds = 30000;
const five_seconds_milliseconds = 5000;
const network_idle_deadline_milliseconds = 30000; // measured from the load event

const args = process.argv.slice(2);

const variation_flag_index = args.indexOf('--variation');
if (variation_flag_index === -1 || !args[variation_flag_index + 1]) {
    console.error('Use ---> node Page_Collector.js --variation <num> [--profile <path>] [--extension <path>]');
    process.exit(1);
}
const variation_id = args[variation_flag_index + 1];

const profile_flag_index = args.indexOf('--profile');
let provided_profile_path = null;
if (profile_flag_index !== -1) {
    provided_profile_path = args[profile_flag_index + 1];
}

const extension_flag_index = args.indexOf('--extension');
let provided_extension_path = null;
if (extension_flag_index !== -1) {
    provided_extension_path = args[extension_flag_index + 1];
}

// load config from file. This will include more regions upon setting up Brave VPN
const config_path = path.join(__dirname, 'config.json');
if (!fs.existsSync(config_path)) {
    console.error('config.json not found');
    process.exit(1);
}

const config = JSON.parse(fs.readFileSync(config_path, 'utf-8'));
const variation = config.variations[variation_id];

if (!variation) {
    console.error(`Variation ${variation_id} not found in config.json`);
    process.exit(1);
}

const { region, consent, resolution } = variation;
const [viewport_width, viewport_height] = resolution;

// Consent-O-Matic is selected automatically by the variation's consent value
const consent_extension_path = path.join(__dirname, `consent-${consent}`);

console.log(
    `Variation ${variation_id}: region=${region} consent=${consent} ` +
    `resolution=${viewport_width}x${viewport_height}`
);



// The three serialization points captured in a single visit, all anchored on the load event
const serialization_points = ['page_load', 'five_seconds', 'network_idle'];




// Output dirs
const variation_directory = path.join(__dirname, 'output', `variation_${variation_id}`);
const profile_directory = path.join(variation_directory, 'profile');
const websites_directory = path.join(variation_directory, 'websites');

for (const directory of [variation_directory, websites_directory]) {
    if (!fs.existsSync(directory)) {
        fs.mkdirSync(directory, { recursive: true });
    }
}





/**
 * Profile handling
 * 
 * 
 * If a profile is provided, copy it into the run profile dir and launch
 * from the copy so the source stays pristine. Otherwise start from a fresh empty profile dir.
 *  
 * */  
function prepare_profile_directory() {
    fs.rmSync(profile_directory, { recursive: true, force: true });

    if (provided_profile_path) {
        if (!fs.existsSync(provided_profile_path)) {
            console.error(`Provided profile not found at ${provided_profile_path}`);
            process.exit(1);
        }
        fs.cpSync(provided_profile_path, profile_directory, { recursive: true });
        console.log(`Profile seeded from ${provided_profile_path}`);
    } else {
        fs.mkdirSync(profile_directory, { recursive: true });
    }
}

function sanitize_for_filesystem(value) {
    return value.replace(/[^a-zA-Z0-9]/g, '_');
}

// TODO: See if we missed any flag to ensure reproducability across crawls
function build_browser_args() {
    const browser_args = [
        '--disable-blink-features=AutomationControlled',
        '--disable-field-trial-config',
        '--disable-features=VizDisplayCompositor,HttpsUpgrades,ThirdPartyStoragePartitioning,Translate,OptimizationHints',
        '--force-color-profile=srgb',
        '--font-render-hinting=none',
        '--disable-sync',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-default-apps',
        '--disable-extensions-file-access-check',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-back-forward-cache',
        '--disable-component-update',
        '--disable-client-side-phishing-detection',
        '--disable-breakpad',
        '--disable-hang-monitor',
        '--disable-ipc-flooding-protection',
        '--disable-prompt-on-repost',
        '--deny-permission-prompts',
        '--disable-notifications',
        '--no-service-autorun',
        '--password-store=basic',
        '--metrics-recording-only',
        '--disable-popup-blocking',
        `--window-size=${viewport_width},${viewport_height}`,
    ];

    // Build the extension load list: Consent-O-Matic (unless no-action) plus any --extension
    const extension_paths = [];

    if (consent !== 'no-action') {
        extension_paths.push(consent_extension_path);
    }

    if (provided_extension_path) {
        extension_paths.push(path.resolve(provided_extension_path));
    }

    if (extension_paths.length > 0) {
        const joined_extension_paths = extension_paths.join(',');
        browser_args.push(`--load-extension=${joined_extension_paths}`);
        browser_args.push(`--disable-extensions-except=${joined_extension_paths}`);
    }

    return browser_args;
}

// Capture the serialized DOM at one point into its own directory
function serialize_to(point_name, domain_output_directory, html_content) {
    const point_directory = path.join(domain_output_directory, point_name);
    if (!fs.existsSync(point_directory)) {
        fs.mkdirSync(point_directory, { recursive: true });
    }

    fs.writeFileSync(path.join(point_directory, 'page.html'), html_content, 'utf-8');
    console.log(`  [${point_name}] HTML saved (${html_content.length} bytes)`);

    return html_content.length;
}





// Core crawl ---> one visit, three serialization points anchored on the load event
async function crawl_domain(domain, browser) {
    let url = domain;
    if (!domain.startsWith('http')) {
        url = `https://${domain}`;
    }

    const sanitized_domain = sanitize_for_filesystem(domain);
    const domain_output_directory = path.join(websites_directory, sanitized_domain);
    if (!fs.existsSync(domain_output_directory)) {
        fs.mkdirSync(domain_output_directory, { recursive: true });
    }

    const metadata = {
        url,
        domain,
        timestamp: new Date().toISOString(),
        variation_id,
        region,
        consent,
        resolution: `${viewport_width}x${viewport_height}`,
        serialization_points,
        success: false,
        failure_reason: null,
        load_event_fired: false,
        network_idle_timed_out: false,
        html_size_bytes: {}
    };

    console.log(`\n--- ${domain} ---`);
    const page = await browser.newPage();

    await page.setViewport({ width: viewport_width, height: viewport_height });
    await page.setExtraHTTPHeaders({ 'Referer': 'https://www.google.com' });

    try {
        // Wait for the load event. If it never fires we still capture the exit-state DOM below.
        console.log(`  Navigating to ${url}...`);
        await page.goto(url, { waitUntil: 'load', timeout: navigation_timeout_milliseconds });
        metadata.load_event_fired = true;

        const load_timestamp = Date.now();




        // Point 1: at the load event
        const page_load_html = await page.content();
        metadata.html_size_bytes.page_load = serialize_to('page_load', domain_output_directory, page_load_html);





        // Point 2: 5 seconds after the load event
        await new Promise(resolve => setTimeout(resolve, five_seconds_milliseconds));
        const five_seconds_html = await page.content();
        metadata.html_size_bytes.five_seconds = serialize_to('five_seconds', domain_output_directory, five_seconds_html);






        // Point 3: network idle, capped at load + 30s
        const remaining_until_deadline = network_idle_deadline_milliseconds - (Date.now() - load_timestamp);
        if (remaining_until_deadline > 0) {
            await page.waitForNetworkIdle({ timeout: remaining_until_deadline }).catch(() => {
                console.log('  network idle not reached before deadline, capturing current state');
                metadata.network_idle_timed_out = true;
            });
        } else {
            metadata.network_idle_timed_out = true;
        }




        const network_idle_html = await page.content();
        metadata.html_size_bytes.network_idle = serialize_to('network_idle', domain_output_directory, network_idle_html);

        metadata.success = true;

    } catch (error) {
        // load never fired (or another nav error) ----------> mark failed but preserve the exit-state HTML for reference
        metadata.failure_reason = error.message;
        console.warn(`  Failed: ${error.message}. Capturing exit-state HTML.`);

        try {
            const exit_state_html = await page.content();
            metadata.html_size_bytes.exit_state = serialize_to('exit_state', domain_output_directory, exit_state_html);
        } catch (capture_error) {
            console.warn(`  Could not capture exit-state HTML: ${capture_error.message}`);
        }

    } finally {
        await page.close().catch(() => {});
    }

    fs.writeFileSync(
        path.join(domain_output_directory, 'metadata.json'),
        JSON.stringify(metadata, null, 2),
        'utf-8'
    );

    return metadata;
}

async function main() {
    const domains_file = path.join(__dirname, 'domains.txt');

    if (!fs.existsSync(domains_file)) {
        console.error('domains.txt not found');
        process.exit(1);
    }

    const domains = fs.readFileSync(domains_file, 'utf-8')
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('#'));

    console.log(`Loaded ${domains.length} domains`);

    prepare_profile_directory();

    const browser = await puppeteer.launch({
        headless: false,
        devtools: false,
        executablePath: '/usr/bin/chromium-browser',
        userDataDir: profile_directory,
        args: build_browser_args(),
        ignoreDefaultArgs: ['--enable-automation'],
        defaultViewport: null
    });

    // Consent-O-Matic ---> open an onboarding tab on install. 
    // Close any extension tabs that appear, so the stealth plugin finishes configuring the page before we close it.
    const close_extension_pages = async () => {
        for (const open_page of await browser.pages()) {
            if (open_page.url().startsWith('chrome-extension://')) {
                await open_page.close().catch(() => {});
            }
        }
    };
    browser.on('targetcreated', () => {
        setTimeout(close_extension_pages, 1500);
    });

    const results = { successful: [], failed: [] };

    for (const domain of domains) {
        const result = await crawl_domain(domain, browser);
        if (result.success) {
            results.successful.push(result.domain);
        } else {
            results.failed.push({ domain: result.domain, error: result.failure_reason });
        }
    }

    await browser.close().catch(() => {});

    console.log(`\nDone. Successful: ${results.successful.length} | Failed: ${results.failed.length}`);

    if (results.failed.length > 0) {
        console.log('Failed domains:');
        for (const failure of results.failed) {
            console.log(`  ${failure.domain}: ${failure.error}`);
        }
    }
}

main();