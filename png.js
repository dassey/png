
/*
 * PNG Metadata Extractor & Chunk Inspector (JavaScript)
 *
 * Copyright (c) 2022 Nayuki
 * All rights reserved. Contact Nayuki for licensing.
 * https://www.nayuki.io/page/png-file-chunk-inspector
 *
 * Heavily modified for Metadata Extraction Project.
 */

"use strict";

var app = new function () {

    /*---- Fields ----*/
    let fileElem = null;
    let analyzeButton = null;
    let messageElem = null;
    let dashboardContainer = null;
    let chunkResultsContainer = null;

    /*---- Initialization ----*/
    document.addEventListener('DOMContentLoaded', () => {
        fileElem = document.getElementById("input-file");
        analyzeButton = document.getElementById("analyze-button");
        messageElem = document.getElementById("message");
        dashboardContainer = document.getElementById("dashboard-container");
        chunkResultsContainer = document.getElementById("chunk-results-container");

        if (!analyzeButton || !fileElem) {
            console.error("Critical elements missing.");
            return;
        }

        analyzeButton.onclick = analyzeFile;
        // Enable drag and drop if the drop zone exists
        const dropZone = document.getElementById('drop-zone');
        if (dropZone) {
            dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('border-blue-500', 'bg-blue-50'); });
            dropZone.addEventListener('dragleave', (e) => { e.preventDefault(); dropZone.classList.remove('border-blue-500', 'bg-blue-50'); });
            dropZone.addEventListener('drop', (e) => {
                e.preventDefault();
                dropZone.classList.remove('border-blue-500', 'bg-blue-50');
                if (e.dataTransfer.files.length) {
                    fileElem.files = e.dataTransfer.files;
                    analyzeFile();
                }
            });
        }
    });

    /*---- Core Analysis Logic ----*/
    function analyzeFile() {
        if (!fileElem.files || fileElem.files.length < 1) {
            if (messageElem) messageElem.textContent = "Please select a file first.";
            return;
        }

        // Reset UI
        if (messageElem) messageElem.textContent = "Reading file...";
        if (dashboardContainer) dashboardContainer.innerHTML = '';
        if (chunkResultsContainer) chunkResultsContainer.innerHTML = '';

        let file = fileElem.files[0];
        let reader = new FileReader();

        reader.onload = function () {
            try {
                let bytes = new Uint8Array(reader.result);

                // 1. Parse Chunks
                let parseResult = readPngChunks(bytes);

                // 2. Parse IHDR for Context
                let ihdrInfo = null;
                const ihdrChunk = parseResult.chunks.find(c => c.type === 'IHDR');
                if (ihdrChunk) {
                    try { ihdrInfo = parseIhdrData(ihdrChunk.data); }
                    catch (e) { parseResult.warnings.push("Failed to parse IHDR: " + e); }
                }

                // 3. Audit Metadata (The "Found/Missing" Logic)
                let auditResult = auditMetadata(parseResult.chunks, ihdrInfo, file);

                // 4. Render Everything
                renderDashboard(auditResult, ihdrInfo, file);
                renderChunkList(parseResult.chunks, parseResult.warnings, ihdrInfo);

                if (messageElem) {
                    messageElem.textContent = "Analysis Complete.";
                    messageElem.className = "text-center text-sm font-medium text-green-600 mb-4";
                }

            } catch (e) {
                console.error(e);
                if (messageElem) {
                    messageElem.textContent = "Error: " + (e.message || "Unknown error");
                    messageElem.className = "text-center text-sm font-medium text-red-600 mb-4";
                }
            }
        };

        reader.readAsArrayBuffer(file);
    }


    /*---- Metadata Auditing ----*/
    function auditMetadata(chunks, ihdrInfo, file) {
        let found = [];
        let missing = [];

        // Helper to add to lists
        const addFound = (label, value, type = 'Standard') => found.push({ label, value, type });
        const addMissing = (label, type = 'Standard') => missing.push({ label, type });

        // 1. File System
        addFound("File Name", file.name, "File System");
        addFound("File Size", formatBytes(file.size), "File System");
        addFound("Last Modified", new Date(file.lastModified).toLocaleString(), "File System");

        // 2. IHDR Basic Info
        if (ihdrInfo) {
            addFound("Dimensions", `${ihdrInfo.width} x ${ihdrInfo.height}`, "Core");
            addFound("Bit Depth", `${ihdrInfo.bitDepth}-bit`, "Core");
            addFound("Color Type", getColorTypeString(ihdrInfo.colorType), "Core");
        }

        // 3. Physical Dimensions (pHYs)
        const phys = chunks.find(c => c.type === 'pHYs');
        if (phys) {
            try {
                let ppuX = readUint32(phys.data, 0);
                let ppuY = readUint32(phys.data, 4);
                let unit = phys.data[8] === 1 ? "pixels/meter" : "unknown unit";
                addFound("Physical Dimensions", `${ppuX}x${ppuY} ${unit}`, "Metadata");
            } catch (e) { addFound("Physical Dimensions", "Present (Invalid Data)", "Metadata"); }
        } else {
            addMissing("Physical Dimensions (DPI)", "Metadata");
        }

        // 4. Time (tIME)
        const time = chunks.find(c => c.type === 'tIME');
        if (time) {
            try {
                let year = readUint16(time.data, 0);
                let month = time.data[2];
                let day = time.data[3];
                addFound("Timestamp (tIME)", `${year}-${month}-${day}`, "Metadata");
            } catch (e) { addFound("Timestamp (tIME)", "Present", "Metadata"); }
        } else {
            addMissing("Timestamp (tIME)", "Metadata");
        }

        // 5. ICC Profile (iCCP)
        const iccp = chunks.find(c => c.type === 'iCCP');
        if (iccp) {
            let name = "Unknown Profile";
            try {
                let nul = iccp.data.indexOf(0);
                if (nul > 0) name = readLatin1(iccp.data, 0, nul);
            } catch (e) { }
            addFound("ICC Profile", name, "Color");
        } else {
            addMissing("ICC Profile", "Color");
        }

        // 6. Exif (eXIf)
        const exif = chunks.find(c => c.type === 'eXIf');
        if (exif) {
            addFound("Exif Data", `${exif.length} bytes`, "Metadata");
        } else {
            addMissing("Exif Data", "Metadata");
        }

        // 7. Textual Data (tEXt, zTXt, iTXt)
        // We want to list specific interesting keys if found, and generic "Text" otherwise
        let textChunks = chunks.filter(c => ['tEXt', 'zTXt', 'iTXt'].includes(c.type));
        let foundKeys = new Set();
        let xmpFound = false;

        textChunks.forEach(c => {
            try {
                let nul = c.data.indexOf(0);
                if (nul > 0) {
                    let key = readLatin1(c.data, 0, nul);
                    foundKeys.add(key);
                    if (key === "XML:com.adobe.xmp") xmpFound = true;
                }
            } catch (e) { }
        });

        if (foundKeys.size > 0) {
            // Group standard keys
            const standardKeys = ["Title", "Author", "Description", "Copyright", "Creation Time", "Software", "Source", "Comment"];
            standardKeys.forEach(k => {
                if (foundKeys.has(k)) addFound(k, "Text Data", "Text");
                else addMissing(k, "Text");
            });

            // List others as generic "Other Text"
            let otherKeys = Array.from(foundKeys).filter(k => !standardKeys.includes(k) && k !== "XML:com.adobe.xmp");
            if (otherKeys.length > 0) {
                addFound("Other Text Keys", otherKeys.join(", "), "Text");
            }
        } else {
            addMissing("Standard Text Metadata", "Text");
        }

        // 8. XMP
        if (xmpFound) addFound("XMP Metadata", "Embedded in iTXt", "Metadata");
        else addMissing("XMP Metadata", "Metadata");

        // 9. sRGB
        if (chunks.find(c => c.type === 'sRGB')) addFound("sRGB Chunk", "Present", "Color");
        else if (!iccp) addMissing("sRGB / Color Space", "Color");

        // 10. AI & Provenance Detection
        // A. C2PA / Content Credentials
        const c2pa = chunks.find(c => c.type === 'c2pa' || c.type === 'C2PA');
        if (c2pa) {
            addFound("Content Credentials (C2PA)", `${c2pa.length} bytes`, "Provenance");
        } else {
            addMissing("Content Credentials (C2PA)", "Provenance");
        }

        // B. AI Signatures (Heuristic Scan)
        let aiDetected = [];

        // Check Text Chunks for common AI keys/values
        textChunks.forEach(c => {
            try {
                let text = extractTextContent(c);
                if (!text) return;

                // Stable Diffusion
                if (text.includes("Stable Diffusion") || text.includes("sd-webui")) aiDetected.push("Stable Diffusion");
                if (c.type === 'tEXt' && text.startsWith("parameters")) aiDetected.push("Stable Diffusion (Parameters)");

                // OpenAI / DALL-E
                if (text.includes("OpenAI") || text.includes("DALL-E")) aiDetected.push("OpenAI / DALL-E");

                // Midjourney
                if (text.includes("Midjourney")) aiDetected.push("Midjourney");

                // Google / Gemini (often in XMP or specific keys, but simple text scan helps)
                if (text.includes("Google") && (text.includes("AI") || text.includes("Gemini"))) aiDetected.push("Google / Gemini");

                // Photoshop Generative Fill (often leaves "Made with Google AI" or similar in XMP/Description if applicable, or Adobe specific tags)
                if (text.includes("Adobe Firefly") || text.includes("Generative Fill")) aiDetected.push("Adobe Firefly");
            } catch (e) { }
        });

        if (aiDetected.length > 0) {
            // Deduplicate
            let uniqueAI = [...new Set(aiDetected)];
            uniqueAI.forEach(ai => addFound("AI Signature Detected", ai, "AI / GenAI"));
        } else {
            addMissing("Common AI Signatures", "AI / GenAI");
        }

        // 11. Deep Scan: Trailing Data
        // Find IEND chunk
        const iend = chunks.find(c => c.type === 'IEND');
        if (iend) {
            // IEND data length is 0, so it's 8 (len+type) + 0 (data) + 4 (crc) = 12 bytes
            // But our 'chunks' array has 'offset' and 'length' (data length).
            // Total chunk size = 12 + data_length.
            // End of IEND = iend.offset + 12 + iend.length (which is 0) = iend.offset + 12.
            const iendEnd = iend.offset + 12;
            if (iendEnd < file.size) {
                const extraBytes = file.size - iendEnd;
                addFound("Trailing Data (Hidden)", `${formatBytes(extraBytes)} after IEND`, "Deep Scan");
            } else {
                addMissing("Trailing Data (Steganography)", "Deep Scan");
            }
        }

        // 12. Deep Scan: Unknown/Private Chunks
        const standardChunks = new Set([
            "IHDR", "PLTE", "IDAT", "IEND",
            "cHRM", "gAMA", "iCCP", "sBIT", "sRGB",
            "bKGD", "hIST", "tRNS",
            "pHYs", "sPLT",
            "tIME", "iTXt", "tEXt", "zTXt",
            "eXIf", "c2pa", "C2PA" // Known extensions
        ]);

        let unknownChunks = chunks.filter(c => !standardChunks.has(c.type));
        if (unknownChunks.length > 0) {
            let types = [...new Set(unknownChunks.map(c => c.type))].join(", ");
            addFound("Unknown/Private Chunks", types, "Deep Scan");
        } else {
            addMissing("Unknown/Private Chunks", "Deep Scan");
        }

        return { found, missing };
    }


    /*---- Rendering Functions ----*/

    function renderDashboard(audit, ihdrInfo, file) {
        if (!dashboardContainer) return;

        // Create the HTML structure for the dashboard
        // We will inject this into the dashboardContainer

        let html = `
            <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
                <!-- Found Metadata Card -->
                <div class="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                    <div class="bg-slate-50 px-4 py-3 border-b border-slate-200 flex justify-between items-center">
                        <h3 class="font-semibold text-slate-700 flex items-center gap-2">
                            <span class="w-2 h-2 rounded-full bg-green-500"></span>
                            Found Metadata
                        </h3>
                        <span class="text-xs font-medium bg-green-100 text-green-700 px-2 py-1 rounded-full">${audit.found.length} items</span>
                    </div>
                    <div class="p-0">
                        ${audit.found.length === 0 ?
                '<div class="p-4 text-slate-400 text-sm italic text-center">No significant metadata found.</div>' :
                '<ul class="divide-y divide-slate-100">' +
                audit.found.map(item => `
                                <li class="px-4 py-3 flex justify-between items-center hover:bg-slate-50 transition-colors">
                                    <span class="text-sm font-medium text-slate-700">${escapeHtml(item.label)}</span>
                                    <span class="text-sm text-slate-500 font-mono bg-slate-100 px-2 py-0.5 rounded">${escapeHtml(item.value)}</span>
                                </li>
                            `).join('') +
                '</ul>'
            }
                    </div>
                </div>

                <!-- Missing Metadata Card -->
                <div class="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                    <div class="bg-slate-50 px-4 py-3 border-b border-slate-200 flex justify-between items-center">
                        <h3 class="font-semibold text-slate-700 flex items-center gap-2">
                            <span class="w-2 h-2 rounded-full bg-slate-300"></span>
                            Checked but Missing
                        </h3>
                        <span class="text-xs font-medium bg-slate-100 text-slate-600 px-2 py-1 rounded-full">${audit.missing.length} items</span>
                    </div>
                    <div class="p-0">
                         ${audit.missing.length === 0 ?
                '<div class="p-4 text-slate-400 text-sm italic text-center">Everything found!</div>' :
                '<ul class="divide-y divide-slate-100">' +
                audit.missing.map(item => `
                                <li class="px-4 py-3 flex justify-between items-center opacity-60 hover:opacity-100 transition-opacity">
                                    <span class="text-sm text-slate-600">${escapeHtml(item.label)}</span>
                                    <span class="text-xs text-slate-400 uppercase tracking-wider">${escapeHtml(item.type)}</span>
                                </li>
                            `).join('') +
                '</ul>'
            }
                    </div>
                </div>
            </div>
        `;
        dashboardContainer.innerHTML = html;
    }

    function renderChunkList(chunks, warnings, ihdrInfo) {
        if (!chunkResultsContainer) return;

        // Header for the section
        let html = `<h2 class="text-xl font-bold text-slate-800 mb-4 flex items-center gap-2">
            <svg class="w-5 h-5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4"></path></svg>
            Chunk Inspector
        </h2>`;

        // Warnings
        if (warnings.length > 0) {
            html += `<div class="bg-yellow-50 border-l-4 border-yellow-400 p-4 mb-6 rounded-r-md">
                <div class="flex">
                    <div class="flex-shrink-0">
                        <svg class="h-5 w-5 text-yellow-400" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>
                    </div>
                    <div class="ml-3">
                        <h3 class="text-sm leading-5 font-medium text-yellow-800">Warnings</h3>
                        <div class="mt-2 text-sm leading-5 text-yellow-700">
                            <ul class="list-disc pl-5 space-y-1">
                                ${warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}
                            </ul>
                        </div>
                    </div>
                </div>
            </div>`;
        }

        // 0. PNG Signature (Offset 0)
        html += `
            <div class="mb-4 rounded-lg border border-slate-200 bg-slate-50 shadow-sm overflow-hidden transition-all hover:shadow-md">
                <div class="px-4 py-3 bg-slate-100 border-b border-slate-200 flex flex-wrap justify-between items-center gap-2">
                    <div class="flex items-center gap-3">
                        <span class="font-mono font-bold text-slate-600 text-lg">SIGNATURE</span>
                        <span class="text-xs text-slate-500 font-mono bg-slate-200 px-2 py-1 rounded">Length: 8</span>
                        <span class="text-xs text-slate-500 font-mono bg-slate-200 px-2 py-1 rounded">Offset: 0</span>
                    </div>
                    <div class="flex items-center gap-2">
                        <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">Valid PNG</span>
                    </div>
                </div>
                <div class="p-4">
                    <p class="text-sm text-slate-700 font-mono">89 50 4E 47 0D 0A 1A 0A</p>
                    <p class="text-xs text-slate-500 mt-1">Standard PNG File Signature</p>
                </div>
            </div>`;

        // Chunks
        let idatHiddenCount = 0;
        chunks.forEach((chunk, index) => {
            // SKIP IDAT CHUNKS entirely to reduce noise
            if (chunk.type === 'IDAT') {
                idatHiddenCount++;
                return;
            }

            const isError = !chunk.crcOk;
            const borderColor = isError ? 'border-red-300' : 'border-slate-200';
            const bgColor = isError ? 'bg-red-50' : 'bg-white';

            // Generate content for the chunk
            let summary = getChunkSummaryText(chunk, ihdrInfo);
            let textContent = extractTextContent(chunk);

            html += `
            <div class="mb-4 rounded-lg border ${borderColor} ${bgColor} shadow-sm overflow-hidden transition-all hover:shadow-md">
                <div class="px-4 py-3 bg-slate-50 border-b ${borderColor} flex flex-wrap justify-between items-center gap-2">
                    <div class="flex items-center gap-3">
                        <span class="font-mono font-bold text-blue-600 text-lg">${escapeHtml(chunk.type)}</span>
                        <span class="text-xs text-slate-500 font-mono bg-slate-200 px-2 py-1 rounded">Length: ${formatNumber(chunk.length)}</span>
                        <span class="text-xs text-slate-500 font-mono bg-slate-200 px-2 py-1 rounded">Offset: ${formatNumber(chunk.offset)}</span>
                    </div>
                    <div class="flex items-center gap-2">
                         ${isError ?
                    '<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">CRC Error</span>' :
                    '<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">CRC OK</span>'
                }
                    </div>
                </div>
                
                <div class="p-4 grid grid-cols-1 lg:grid-cols-3 gap-4">
                    <div class="lg:col-span-1">
                        <h4 class="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Summary</h4>
                        <p class="text-sm text-slate-700 leading-relaxed">${summary}</p>
                    </div>
                    
                    <div class="lg:col-span-2">
                        <h4 class="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Data / Content</h4>
                        ${textContent ?
                    `<div class="bg-slate-900 rounded-md p-3 overflow-x-auto">
                                <pre class="text-xs font-mono text-slate-300 whitespace-pre-wrap break-all">${escapeHtml(textContent)}</pre>
                             </div>` :
                    `<div class="text-sm text-slate-400 italic">Binary data (not displayed)</div>`
                }
                    </div>
                </div>
            </div>`;
        });

        if (idatHiddenCount > 0) {
            html += `<div class="text-center text-sm text-slate-400 italic mt-4 mb-8">(${idatHiddenCount} IDAT chunks hidden)</div>`;
        }

        chunkResultsContainer.innerHTML = html;
    }



    // Helper to extract text content for display
    function extractTextContent(chunk) {
        try {
            if (chunk.type === 'tEXt') {
                let nul = chunk.data.indexOf(0);
                if (nul > 0) return readLatin1(chunk.data, nul + 1, chunk.length - (nul + 1));
            }
            if (chunk.type === 'iTXt') {
                let nul0 = chunk.data.indexOf(0);
                if (nul0 > 0 && nul0 + 3 <= chunk.length) {
                    let compFlag = chunk.data[nul0 + 1];
                    if (compFlag === 0) { // Uncompressed
                        let nul1 = chunk.data.indexOf(0, nul0 + 3);
                        let nul2 = chunk.data.indexOf(0, nul1 + 1);
                        if (nul2 > 0) return readUtf8(chunk.data, nul2 + 1, chunk.length - (nul2 + 1));
                    } else {
                        return "[Compressed iTXt data - decompression not implemented in browser]";
                    }
                }
            }
            if (chunk.type === 'zTXt') return "[Compressed zTXt data]";
            if (chunk.type === 'eXIf') return `[Exif Data Block - ${chunk.length} bytes]`;
            if (chunk.type === 'iCCP') return `[ICC Profile Data - ${chunk.length} bytes]`;
        } catch (e) { return "[Error extracting text]"; }
        return null;
    }


    /*---- PNG Parsing (Low Level) ----*/
    function readPngChunks(bytes) {
        const PNG_SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        if (bytes.length < 8 || !bytes.subarray(0, 8).every((b, i) => (b === PNG_SIGNATURE[i])))
            throw new Error("Not a PNG file (invalid signature)");
        let chunks = [];
        let warnings = [];
        let index = 8;

        while (index < bytes.length) {
            if (index + 8 > bytes.length) { warnings.push(`Offset ${index}: Unexpected end of file`); break; }
            let length = readUint32(bytes, index + 0);
            let type = readAscii(bytes, index + 4, 4);

            // Safety check for corrupt lengths
            if (length >= 0x80000000) { warnings.push(`Chunk ${type} has invalid length ${length}`); break; }

            let chunkEndIndex = index + 8 + length + 4;
            if (chunkEndIndex > bytes.length) { warnings.push(`Chunk ${type} data truncated`); break; }

            let data = bytes.subarray(index + 8, index + 8 + length);
            let actualCrc = readUint32(bytes, index + 8 + length);
            let typeBytes = new Uint8Array(4); for (let i = 0; i < 4; i++) typeBytes[i] = type.charCodeAt(i);
            let expectedCrc = computeCrc(typeBytes, data);
            let crcOk = (actualCrc === expectedCrc);

            // Suppress IDAT CRC warnings as per user request
            if (!crcOk && type !== 'IDAT') warnings.push(`Chunk ${type} CRC mismatch`);

            chunks.push({ type, length, data, offset: index, crc: actualCrc, crcOk });
            index = chunkEndIndex;
        }
        return { chunks, warnings };
    }

    function parseIhdrData(data) {
        if (data.length !== 13) throw "Invalid IHDR length";
        let width = readUint32(data, 0);
        let height = readUint32(data, 4);
        let bitDepth = data[8];
        let colorType = data[9];
        return { width, height, bitDepth, colorType };
    }

    function getChunkSummaryText(chunk, ihdrInfo) {
        try {
            // Re-using the switch logic from previous version, simplified for brevity
            let data = chunk.data;
            switch (chunk.type) {
                case "IHDR":
                    let i = parseIhdrData(data);
                    return `${i.width}x${i.height}, ${i.bitDepth}-bit, Type ${i.colorType}`;
                case "tEXt":
                case "zTXt":
                case "iTXt":
                    let nul = data.indexOf(0);
                    return `Key: "${readLatin1(data, 0, nul)}"`;
                case "pHYs":
                    let px = readUint32(data, 0), py = readUint32(data, 4);
                    return `Pixel Aspect Ratio: ${px}x${py}`;
                case "tIME":
                    return `Timestamp: ${readUint16(data, 0)}-${data[2]}-${data[3]}`;
                case "gAMA":
                    return `Gamma: ${(readUint32(data, 0) / 100000).toFixed(5)}`;
                case "cHRM":
                    return "Chromaticity coordinates";
                case "PLTE":
                    return `Palette: ${chunk.length / 3} colors`;
                case "IDAT":
                    return "Image Data (Compressed)";
                default:
                    return `${chunk.length} bytes of data`;
            }
        } catch (e) { return "Error parsing summary"; }
    }

    /*---- Utilities ----*/
    // CRC Table
    let crcTable = null;
    function computeCrc(typeBytes, dataBytes) {
        if (!crcTable) {
            crcTable = new Int32Array(256);
            for (let i = 0; i < 256; i++) {
                let c = i;
                for (let j = 0; j < 8; j++) c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
                crcTable[i] = c;
            }
        }
        let crc = 0xFFFFFFFF;
        for (let b of typeBytes) crc = crcTable[(crc ^ b) & 0xFF] ^ (crc >>> 8);
        for (let b of dataBytes) crc = crcTable[(crc ^ b) & 0xFF] ^ (crc >>> 8);
        return crc ^ 0xFFFFFFFF;
    }

    function readUint16(b, i) { return (b[i] << 8) | b[i + 1]; }
    function readUint32(b, i) { return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0; }
    function readAscii(b, i, l) { let s = ""; for (let j = 0; j < l; j++) s += String.fromCharCode(b[i + j]); return s; }
    function readLatin1(b, i, l) { let s = ""; for (let j = 0; j < l; j++) s += String.fromCharCode(b[i + j]); return s; }
    function readUtf8(b, i, l) { return new TextDecoder("utf-8").decode(b.subarray(i, i + l)); }
    function formatNumber(n) { return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
    function formatBytes(bytes, decimals = 2) {
        if (!+bytes) return '0 Bytes';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
    }
    function getColorTypeString(type) {
        const map = { 0: "Grayscale", 2: "Truecolor", 3: "Indexed", 4: "Gray+Alpha", 6: "RGBA" };
        return map[type] || "Unknown";
    }
    function escapeHtml(unsafe) {
        if (typeof unsafe !== 'string') return unsafe;
        return unsafe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
    }

};
