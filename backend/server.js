import express from 'express';
import connectDB from './config/db.js';
import dotenv from 'dotenv';
import multer from 'multer';
import cors from 'cors';
import authRoutes from './routes/auth.js';
import applicationRoutes from './routes/application.js';
import { exec } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { readFile } from 'fs/promises';
import puppeteer from 'puppeteer';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import User from './models/User.js'; // adjust the path if it's different
import TrackedInternship from './models/TrackedInternship.js';
import { fetchGitHubProfile } from './github/tempFile.js';
import atsScoreRoute from './routes/atsScore.js';


dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'DELETE'] }));
app.use(express.json());

const upload = multer({ dest: 'uploads/' });

// ✅ Python resume extractor route
app.post('/api/upload', upload.single('resume'), (req, res) => {
  const uploadedPath = path.resolve(__dirname, req.file.path);
  const pythonPath = 'python3'; // or 'python'
  const scriptPath = path.resolve(__dirname, 'skill_extractor.py');

  exec(`"${pythonPath}" "${scriptPath}" "${uploadedPath}"`, {
      env: {
          ...process.env,
          PATH: `${path.join(__dirname, 'venv/bin')}:${process.env.PATH}`,
          VIRTUAL_ENV: path.resolve(__dirname, 'venv')
      }
  }, (err, stdout, stderr) => {
      // IMPORTANT: Ensure the uploaded file is cleaned up regardless of outcome
      fs.unlink(uploadedPath, (unlinkErr) => {
          if (unlinkErr) console.error("Error deleting uploaded file:", unlinkErr);
      });

      // Log both stdout and stderr for full debugging context
      console.log("Python script raw stdout:\n", stdout);
      if (stderr) console.error("Python script raw stderr:\n", stderr);


      if (err) { // Python script exited with a non-zero code
          console.error("❌ Python Execution Error (exit code !== 0):", err);
          
          try {
              const errorOutput = JSON.parse(stdout); // Attempt to parse stdout as JSON error
              if (errorOutput.error === "Gemini_Quota_Exhausted") {
                  // If skill_extractor.py explicitly signals quota exhaustion
                  return res.status(429).json({ 
                      error: "AI assistant is currently unavailable due to quota limits.",
                      reason: errorOutput.message 
                  });
              } else {
                  // Other types of structured errors from the Python script
                  return res.status(500).json({ 
                      error: `Python script error: ${errorOutput.error || 'Unknown'}`, 
                      reason: errorOutput.message || stdout 
                  });
              }
          } catch (jsonParseError) {
              // If stdout is not valid JSON when an error occurred, it's a generic script failure
              console.error("❌ Failed to parse Python script stdout as JSON (during error):", jsonParseError);
              return res.status(500).json({ 
                  error: "Python script execution failed.", 
                  reason: stderr || err.message || stdout // Provide stderr, exec error message, or raw stdout
              });
          }
      }

      // If execution was successful (err is null or code is 0)
      try {
          // Attempt to parse stdout as JSON for successful execution
          const pythonOutput = JSON.parse(stdout);

          if (pythonOutput && Array.isArray(pythonOutput.internships)) {
              // Successfully parsed and found the 'internships' array
              return res.status(200).json({ internships: pythonOutput.internships });
          } else {
              // stdout was valid JSON, but didn't contain the expected 'internships' array
              console.error("❌ Python script output did not contain 'internships' array:", pythonOutput);
              return res.status(500).json({ error: "Invalid output format from Python script." });
          }
      } catch (jsonParseError) {
          // stdout was not valid JSON for a successful response (unexpected)
          console.error("❌ Failed to parse Python script stdout as JSON (during success):", jsonParseError);
          console.error("Raw stdout causing parse error:", stdout);
          return res.status(500).json({ error: "Invalid or malformed JSON output from Python script." });
      }
  });
});


// ✅ Resume Builder Route (Gemini + modern.html)
function parseSection(raw, count) {
  return raw
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const parts = line.split(',').map(p => p.trim());
      if (parts.length < count) return null;

      if (count === 3) return { degree: parts[0], institution: parts[1], year: parts[2] };
      if (count === 4) return { role: parts[0], company: parts[1], year: parts[2], description: parts[3] };
      if (count === 2) return { title: parts[0], description: parts[1] };
    })
    .filter(Boolean);
}
app.post('/api/generate-resume', async (req, res) => {
  try {
    const { name, email, phone, linkedin, goal, education, experience, projects, skills } = req.body;

    const skillList = skills.split(',').map(s => s.trim());

    const resumeData = {
      name,
      goal,
      skills: skillList,
      education,     // already structured
      experience,    // already structured
      projects       // already structured
    };

    const child = exec('python3 resume.py', { cwd: __dirname });
    child.stderr.on('data', (data) => {
      console.error(`🔴 resume.py stderr: ${data}`);
    });
    let summary = [];
    let pythonError = null; // Variable to store custom Python error

    child.stdin.write(JSON.stringify(resumeData));
    child.stdin.end();

    let stdout = '';
    child.stdout.on('data', data => { stdout += data; });

    child.on('close', async (code) => { // Listen to the exit code
      try {
        if (code !== 0) { // Python script exited with an error
            try {
                const errorOutput = JSON.parse(stdout); // Try to parse stdout as JSON error
                if (errorOutput.error === "Gemini_Quota_Exhausted") {
                    pythonError = { status: 429, message: `Gemini API high usage: ${errorOutput.message}` }; // 429 Too Many Requests
                } else if (errorOutput.error === "Summary_Generation_Failed") {
                    pythonError = { status: 500, message: `Summary generation failed in Python: ${errorOutput.message}` };
                } else {
                    pythonError = { status: 500, message: `Unknown Python script error: ${stdout}` };
                }
            } catch (parseError) {
                // If stdout is not JSON, it's a generic Python error
                pythonError = { status: 500, message: `Python script exited with code ${code} and non-JSON output: ${stdout}` };
            }
        } else {
            // Script exited successfully, try to parse summary
            summary = JSON.parse(stdout);
        }
      } catch (err) {
        // This catch handles errors during JSON parsing of stdout if code is 0
        pythonError = { status: 500, message: `Failed to parse Python script stdout as JSON: ${err.message}. Raw output: ${stdout}` };
      }

      if (pythonError) {
          console.error("❌ Resume generation error from Python:", pythonError.message);
          return res.status(pythonError.status).send(pythonError.message);
      }

      const template = await readFile(path.resolve(__dirname, 'templates/modern.html'), 'utf-8');
      let filled = template
        .replace(/{{ data.name }}/g, name)
        .replace(/{{ data.email }}/g, email)
        .replace(/{{ data.phone }}/g, phone)
        .replace(/{{ data.linkedin }}/g, linkedin)
        .replace(/{{ data.summary\[0\] }}/g, summary.join(' '))
        .replace(/{{ data.skills \| join\(', '\) }}/g, skillList.join(', '));

        filled = filled.replace(
  /{% for edu in data.education %}[\s\S]*?{% endfor %}/,
  education.map(e => `<li><strong>${e.degree}</strong>, ${e.institution} (${e.year})</li>`).join('')
);

filled = filled.replace(
  /{% for exp in data.experience %}[\s\S]*?{% endfor %}/,
  experience.map(e => `<li><strong>${e.role}</strong> at ${e.company} (${e.year})<br>${e.description}</li>`).join('')
);

filled = filled.replace(
  /{% for proj in data.projects %}[\s\S]*?{% endfor %}/,
  projects.map(p => `<li><strong>${p.title}</strong>: ${p.description}</li>`).join('')
);

      res.send(filled);
    });

  } catch (err) {
    console.error("❌ Resume generation error (Node.js caught):", err);
    res.status(500).send("Resume generation failed.");
  }
});

app.post('/api/download-resume-pdf', async (req, res) => {
  const { html } = req.body;

  if (!html) {
    return res.status(400).send("Missing HTML content.");
  }

  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });

    const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
    await browser.close();

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="resume.pdf"'
    });
    res.send(pdfBuffer);

  } catch (err) {
    console.error("❌ PDF generation failed:", err);
    res.status(500).send("Failed to generate PDF.");
  }
});

// ✅ Connect DB and Auth
connectDB();
app.use('/api', authRoutes);
app.use('/api', applicationRoutes);

// ✅ Track Internship Route
app.post('/api/track-internship', async (req, res) => {
  const { userId, title, company, link, ats } = req.body;

  if (!userId || !title || !company || !link) {
    return res.status(400).json({ message: "Missing required fields" });
  }

  try {
    const newTrack = new TrackedInternship({
      userId,
      title,
      company,
      link,
      ats
    });

    await newTrack.save();
    res.status(201).json({ message: "Internship tracked successfully" });
  } catch (err) {
    console.error("Track error:", err);
    res.status(500).json({ message: "Server error while tracking internship" });
  }
});

// ✅ Get All Tracked Internships for a User
app.get('/api/tracked-internships/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const internships = await TrackedInternship.find({ userId }).sort({ trackedAt: -1 });
    res.status(200).json(internships);
  } catch (err) {
    console.error("Fetch error:", err);
    res.status(500).json({ message: "Failed to fetch tracked internships." });
  }
});

// ✅ Signup Route
app.post('/api/signup', async (req, res) => {
  const { name, email, password } = req.body;

  try {
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: 'User already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({ name, email, password: hashedPassword });
    await newUser.save();

    res.status(201).json({ message: 'User created successfully' });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ message: 'Server error during signup' });
  }
});

// ❌ Untrack internship by ID
app.delete('/api/untrack-internship/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await TrackedInternship.findByIdAndDelete(id);

    if (!deleted) {
      return res.status(404).json({ message: 'Internship not found' });
    }

    res.status(200).json({ message: 'Internship untracked successfully' });
  } catch (err) {
    console.error("Untrack error:", err);
    res.status(500).json({ message: "Server error during untracking" });
  }
});


app.get('/api/import/github/:username', async (req, res) => {
  try {
    const data = await fetchGitHubProfile(req.params.username);
    res.status(200).json(data);
  } catch (err) {
    console.error("GitHub Import Error:", err);
    res.status(500).json({ error: "Failed to fetch GitHub data" });
  }
});

app.use('/api', atsScoreRoute);


// ✅ Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));