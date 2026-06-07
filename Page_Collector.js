const puppeteer = require('puppeteer-extra');
const stealth_plugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

puppeteer.use(stealth_plugin());

const navigation_timeout_milliseconds = 30000;

const args = process.argv.slice(2);

const variation_flag_index = args.indexOf('--variation');
if (variation_flag_index === -1 || !args[variation_flag_index + 1]) {
    console.error('Use ---> node Page_Collector.js --variation <num> <--page-load | --net-idle | --30-secs>');
    process.exit(1);
}


const variation_id = args[variation_flag_index + 1];
const flag_to_serialization_point = {
    '--page-load': 'domcontentloaded',
    '--net-idle': 'networkidle0',
    '--30-secs': 'networkidle0+30s'
};

const selected_serialization_flags = Object.keys(flag_to_serialization_point)
    .filter(flag => args.includes(flag));

if (selected_serialization_flags.length !== 1) {
    console.error('Provide exactly one serialization flag: --page-load | --net-idle | --30-secs');
    process.exit(1);
}

const serialization_point = flag_to_serialization_point[selected_serialization_flags[0]];

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
if (!Array.isArray(config.serialization_points) || !config.serialization_points.includes(serialization_point)) {
    console.error(`Serialization point "${serialization_point}" is not listed in config.serialization_points`);
    process.exit(1);
}














const { region, consent, resolution } = variation;
const [viewport_width, viewport_height] = resolution;


const extension_load_path = path.join(__dirname, `consent-${consent}`);


/**
 * Parse serialization behavior from the point string
 *  "domcontentloaded"  -> base "domcontentloaded", 0 extra ms
 *  "networkidle0"      -> base "networkidle0",      0 extra ms
 *  "networkidle0+30s"  -> base "networkidle0",      30000 extra ms
 * 
 * 
 * 
 */ 
function parse_serialization_behavior(point) {
    const [base_point, delay_suffix] = point.split('+');
    let extra_delay_milliseconds = 0;

    if (delay_suffix) {
        const delay_match = delay_suffix.match(/^(\d+)s$/);
        if (!delay_match) {
            console.error(`Unable to parse delay from serialization point "${point}"`);
            process.exit(1);
        }
        extra_delay_milliseconds = parseInt(delay_match[1], 10) * 1000;
    }

    return { base_point, extra_delay_milliseconds };
}

const { base_point, extra_delay_milliseconds } = parse_serialization_behavior(serialization_point);

console.log(
    `Variation ${variation_id}: region=${region} consent=${consent} ` +
    `resolution=${viewport_width}x${viewport_height} serialization_point=${serialization_point}`
);

//Output dirs
const variation_directory = path.join(__dirname, 'output', `variation_${variation_id}`);
const profile_directory = path.join(variation_directory, 'profile');
const websites_directory = path.join(variation_directory, 'websites');

for (const directory of [variation_directory, profile_directory, websites_directory]) {
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
}




function sanitize_for_filesystem(value) {
    return value.replace(/[^a-zA-Z0-9]/g, '_');
}










// TODO: See if we missed any flag to ensure reproducability across crawls
function build_browser_args() {
    const browser_args = [
        '--disable-blink-features=AutomationControlled',
        '--disable-field-trial-config',
        '--disable-features=VizDisplayCompositor,HttpsUpgrades,ThirdPartyStoragePartitioning',
        '--force-color-profile=srgb',
        '--font-render-hinting=none',
        '--disable-sync',
        '--no-first-run',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-client-side-phishing-detection',
        '--disable-breakpad',
        '--metrics-recording-only',
        '--disable-popup-blocking',
        `--window-size=${viewport_width},${viewport_height}`,
    ];

    if (consent !== 'no-action') {
        browser_args.push(
            `--load-extension=${extension_load_path}`,
            `--disable-extensions-except=${extension_load_path}`
        );
    }




    return browser_args;
}





//Core crawl (single serialization point)
async function crawl_domain(domain, browser) {
    const url = domain.startsWith('http') ? domain : `https://${domain}`;
    const sanitized_domain = sanitize_for_filesystem(domain);
    const sanitized_point = sanitize_for_filesystem(serialization_point);

    const point_output_directory = path.join(websites_directory, sanitized_domain, sanitized_point);
    if (!fs.existsSync(point_output_directory)) {
        fs.mkdirSync(point_output_directory, { recursive: true });
    }

    const metadata = {
        url,
        domain,
        timestamp: new Date().toISOString(),
        variation_id,
        region,
        consent,
        resolution: `${viewport_width}x${viewport_height}`,
        serialization_point,
        base_point,
        extra_delay_milliseconds,
        success: false,
        failure_reason: null,
        network_idle_timed_out: false,
        html_size_bytes: null
    };

    console.log(`\n--- ${domain} [${serialization_point}] ---`);
    const page = await browser.newPage();

    await page.setViewport({ width: viewport_width, height: viewport_height });
    await page.setExtraHTTPHeaders({ 'Referer': 'https://www.google.com' });

    try {
        // domcontentloaded is the reliable navigation anchor for every point.
        console.log(`  Navigating to ${url}...`);
        await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: navigation_timeout_milliseconds
        });

        // Network-idle based points: wait for the current page to go quiet.
        if (base_point === 'networkidle0') {
            console.log('  Waiting for network idle...');
            await page.waitForNetworkIdle().catch(() => {
                console.log('  network idle not reached within timeout, capturing current state');
                metadata.network_idle_timed_out = true;
            });
        }

        // Optional extra settle time after the base point.
        if (extra_delay_milliseconds > 0) {
            console.log(`  Sleeping ${extra_delay_milliseconds / 1000}s...`);
            await new Promise(resolve => setTimeout(resolve, extra_delay_milliseconds));
        }

        // Serialize.
        const html_content = await page.content();
        fs.writeFileSync(path.join(point_output_directory, 'page.html'), html_content, 'utf-8');
        metadata.success = true;
        metadata.html_size_bytes = html_content.length;
        console.log(`  HTML saved (${html_content.length} bytes)`);

    } catch (error) {
        metadata.failure_reason = error.message;
        console.warn(`  Failed: ${error.message}`);

    } finally {
        await page.close().catch(() => {});
    }

    fs.writeFileSync(
        path.join(point_output_directory, 'metadata.json'),
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

    const browser = await puppeteer.launch({
        headless: false,
        devtools: false,
        executablePath: '/usr/bin/chromium-browser', 
        userDataDir: profile_directory,
        args: build_browser_args(),
        ignoreDefaultArgs: ['--enable-automation'],
        defaultViewport: null
    });

    const close_extension_pages = async () => {
        for (const open_page of await browser.pages()) {
            if (open_page.url().startsWith('chrome-extension://')) {
                await open_page.close().catch(() => {});
            }
        }
    };
    browser.on('targetcreated', () => { setTimeout(close_extension_pages, 1500); });

    
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

    console.log(`\nDone [${serialization_point}]. Successful: ${results.successful.length} | Failed: ${results.failed.length}`);

    if (results.failed.length > 0) {
        console.log('Failed domains:');
        for (const failure of results.failed) {
            console.log(`  ${failure.domain}: ${failure.error}`);
        }
    }
}

main();