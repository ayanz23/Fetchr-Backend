// server.js

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const multer = require('multer');
const path = require('path');

// --- 1. SETUP & SECURITY ---

// Load environment variables (including GEMINI_API_KEY) from .env file
dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080; // Backend port

// Verify API Key existence (Security Check)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 

if (!GEMINI_API_KEY) {
  console.error("❌ FATAL ERROR: GEMINI_API_KEY is not set in the .env file.");
  process.exit(1); 
}

// Initialize the Gemini AI client with the secure key
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
console.log("✅ Gemini AI client initialized.");

// --- 2. MIDDLEWARE (CORS FIX) ---

// CORS: Allow requests from React frontend, iOS simulators, and native apps
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    const allowedOrigins = [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://localhost:8080',
      'http://127.0.0.1:8080',
      // iOS simulator origins
      'http://localhost:19006', // Expo default
      'http://127.0.0.1:19006',
      'http://localhost:19000', // Expo alternative
      'http://127.0.0.1:19000',
      // Capacitor iOS origins
      'capacitor://localhost',
      'ionic://localhost',
      'http://localhost',
      'https://localhost',
      // Common development IP ranges
      /^http:\/\/192\.168\.\d+\.\d+:\d+$/,  // 192.168.x.x
      /^http:\/\/10\.\d+\.\d+\.\d+:\d+$/,   // 10.x.x.x
      /^http:\/\/172\.(1[6-9]|2[0-9]|3[0-1])\.\d+\.\d+:\d+$/ // 172.16-31.x.x
    ];
    
    // Check if origin matches any allowed pattern
    const isAllowed = allowedOrigins.some(pattern => {
      if (pattern instanceof RegExp) {
        return pattern.test(origin);
      }
      return pattern === origin;
    });
    
    if (isAllowed) {
      callback(null, true);
    } else {
      console.log(`⚠️  CORS blocked origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// Debug middleware to log request origins
app.use((req, res, next) => {
  console.log(`📱 Request from: ${req.get('Origin') || 'No Origin header'} | User-Agent: ${req.get('User-Agent')?.substring(0, 50) || 'Unknown'}`);
  next();
});

// Middleware to parse incoming JSON bodies from the frontend
app.use(express.json());

// --- 3. PET ASSISTANT SYSTEM PROMPT ---

const createPetAssistantPrompt = (petData, sensorData) => {
  const petName = petData?.name || 'your pet';
  const petBreed = petData?.breed || 'unknown breed';
  const petAge = petData?.birthdate ? 
    Math.floor((Date.now() - new Date(petData.birthdate).getTime()) / (365.25 * 24 * 60 * 60 * 1000)) : 
    'unknown age';
  
  const currentStatus = sensorData ? 
    `Current Status: ${sensorData.activityStatus || 'Unknown'}, Heart Rate: ${sensorData.heartRate || 'No data'} bpm, Danger Mode: ${sensorData.dangerMode ? 'ACTIVE' : 'Safe'}` : 
    'No current sensor data available';

  return `You are Fetchr, a personalized pet care assistant for ${petName}, a ${petAge}-year-old ${petBreed}. 

PERSONALITY & MANNERISMS:
- You are warm, caring, and deeply knowledgeable about pet health and behavior
- You speak with genuine concern for ${petName}'s wellbeing
- You use encouraging, supportive language and occasionally include pet-related emojis
- You're proactive about health monitoring and safety
- You remember important details about ${petName} and reference them in conversations
- You provide practical, actionable advice tailored to ${petName}'s specific needs

PET PROFILE:
- Name: ${petName}
- Breed: ${petBreed}
- Age: ${petAge} years old
- ${currentStatus}

EXPERTISE AREAS:
- Pet health monitoring and early warning signs
- Breed-specific care recommendations for ${petBreed}
- Emergency response and first aid
- Behavioral insights and training tips
- Nutrition and exercise guidance
- Safety and geofencing alerts
- Vet appointment scheduling and preparation
- Community support and socialization

RESPONSE GUIDELINES:
- Always prioritize ${petName}'s safety and health
- Provide specific, actionable advice when possible
- Reference ${petName} by name to create a personal connection
- Use your knowledge of ${petBreed} characteristics to give breed-specific advice
- If sensor data indicates concerns, address them immediately
- Be encouraging and supportive while maintaining professional expertise
- Keep responses concise but comprehensive
- End responses with relevant follow-up questions when appropriate

Remember: You're not just an AI assistant - you're ${petName}'s dedicated care companion, always looking out for their best interests. Keep responses short and concise (1-2 sentences max), avoid wasting tokens with long messages.`;
};

// --- 4. GEMINI API ROUTE ---

app.post('/api/generate-content', async (req, res) => {
  console.log('\n--- NEW PET ASSISTANT REQUEST ---');
  try {
    const { messages, petData, sensorData } = req.body; 
    console.log(`Step 1: Received ${messages?.length || 0} messages from frontend.`);
    console.log(`Pet Data:`, petData ? `${petData.name} (${petData.breed})` : 'No pet data');
    console.log(`Sensor Data:`, sensorData ? 'Available' : 'No sensor data');

    if (!messages || messages.length === 0) {
      console.error('Step 1 Failed: Messages array is missing or empty.');
      return res.status(400).json({ error: 'Messages array is required and cannot be empty.' });
    }

    // Create the personalized system prompt
    const systemPrompt = createPetAssistantPrompt(petData, sensorData);
    console.log('Step 2: Created personalized system prompt for pet assistant');

    // Convert the frontend's simplified ChatMessage[] format to 
    // the Google GenAI SDK's expected 'Content' format.
    const contents = [
      // Add system prompt as first message
      {
        role: 'user',
        parts: [{ text: systemPrompt }]
      },
      // Add conversation history
      ...messages
        .filter(m => m.role !== 'system')
        .map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user', 
          parts: [{ text: m.content }]
        }))
    ];
    
    console.log(`Step 3: Mapped ${contents.length} messages for the API (including system prompt).`);

    if (contents.length === 0) {
       console.error('Step 3 Failed: No valid user/assistant messages remained after filtering.');
       return res.status(400).json({ error: 'No user or assistant messages found after processing.' });
    }

    // CRITICAL: Gemini chat history must start with 'user' role
    if (contents.length > 1 && contents[0].role !== 'user') {
      console.error('Step 3 Failed: First message must be from user, got:', contents[0].role);
      return res.status(400).json({ 
        error: 'Invalid message history: First message must be from user role.',
        details: `First message has role: ${contents[0].role}` 
      });
    }

    // Select the model with enhanced configuration for pet care
    const model = genAI.getGenerativeModel({ 
      model: 'gemini-2.0-flash-exp',
      generationConfig: {
        maxOutputTokens: 2048,
        temperature: 0.7, // Slightly lower for more consistent, professional responses
        topP: 0.8,
        topK: 40
      }
    });
    
    console.log('Step 4: Calling Gemini API with pet assistant configuration...');
    
    let result;
    
    // Handle single message vs conversation
    if (contents.length === 1) {
      // Single message - use generateContent
      console.log('Using generateContent for single message');
      result = await model.generateContent(contents[0].parts[0].text);
    } else {
      // Multi-turn conversation - use chat
      console.log('Using chat for multi-turn conversation');
      
      // Validate that messages alternate between user and model
      for (let i = 0; i < contents.length - 1; i++) {
        if (contents[i].role === contents[i + 1].role) {
          console.warn(`Warning: Consecutive ${contents[i].role} messages at index ${i}`);
        }
      }
      
      const chat = model.startChat({
        history: contents.slice(0, -1),
      });
      
      const lastMessage = contents[contents.length - 1];
      result = await chat.sendMessage(lastMessage.parts[0].text);
    }
    
    const response = result.response;
    
    console.log('Step 5: Received response from Gemini Pet Assistant');
    
    // Get the text from response
    let text;
    try {
      text = response.text();
    } catch (textError) {
      console.error('Error extracting text from response:', textError);
      console.log('Response structure:', JSON.stringify(response, null, 2));
      throw new Error('Failed to extract text from Gemini response');
    }
    
    if (!text || text.trim().length === 0) {
        console.warn('Step 6 WARNING: Gemini response did not contain usable text.');
        
        let blockReason = 'Unknown reason.';
        
        if (response.promptFeedback) {
            blockReason = response.promptFeedback.blockReason || 'No block reason provided.';
            console.warn('Prompt Feedback:', response.promptFeedback);
        }
        if (response.candidates && response.candidates.length > 0) {
            console.warn('First candidate:', JSON.stringify(response.candidates[0], null, 2));
        }

        return res.status(500).json({ 
            error: 'Failed to generate content (Response was empty or blocked).',
            details: `Block Reason: ${blockReason}`
        });
    }
    
    console.log(`Step 6 SUCCESS: Sending personalized pet assistant response (length: ${text.length}).`);
    console.log('Response preview:', text.substring(0, 150));
    
    res.json({ content: text });

  } catch (error) {
    console.error('❌ FAILED: Error during pet assistant processing');
    console.error('Error name:', error.name);
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    
    res.status(500).json({ 
      error: 'Internal Server Error: Pet Assistant API communication failed.',
      details: error.message 
    });
  }
});

// --- 5. HEALTH CHECK ENDPOINT ---

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    service: 'Fetchr Pet Assistant API',
    timestamp: new Date().toISOString()
  });
});

// --- 6. START SERVER ---

app.listen(PORT, () => {
  console.log(`\n🚀 Fetchr Pet Assistant API running on http://localhost:${PORT}`);
  console.log("📱 Listening for requests from http://localhost:3000");
  console.log("🤖 Pet Assistant endpoints:");
  console.log("  POST   /api/generate-content");
  console.log("  GET    /api/health");
  console.log("🐾 Ready to provide personalized pet care assistance!");
});