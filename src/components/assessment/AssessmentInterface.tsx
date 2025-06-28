import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Mic, MicOff, Send, Bot, User, Volume2, VolumeX, Clock, AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { FloatingVideoMonitor } from './FloatingVideoMonitor';
import { ConversationMessage, SecurityAlert, FaceDetectionData } from '../../types';
import { v4 as uuidv4 } from 'uuid';

interface AssessmentConfig {
  duration: number;
  questions: string[];
  enableFaceDetection: boolean;
  enableScreenLock: boolean;
  enableAudioRecording: boolean;
  maxViolations: number;
  allowRetake: boolean;
}

interface AssessmentInterfaceProps {
  config: AssessmentConfig;
  onAssessmentComplete: (result: any) => void;
  onTerminate?: () => void;
}

export const AssessmentInterface: React.FC<AssessmentInterfaceProps> = ({
  config,
  onAssessmentComplete,
  onTerminate
}) => {
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [inputMessage, setInputMessage] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [assessmentStartTime] = useState(Date.now());
  const [securityAlerts, setSecurityAlerts] = useState<any[]>([]);
  const [faceDetectionData, setFaceDetectionData] = useState<FaceDetectionData | null>(null);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [isAISpeaking, setIsAISpeaking] = useState(false);
  const [isMicMuted, setIsMicMuted] = useState(true);
  const [waitingForUserResponse, setWaitingForUserResponse] = useState(false);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const speechRecognitionRef = useRef<any>(null);
  const speechSynthesisRef = useRef<SpeechSynthesisUtterance | null>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px';
    }
  }, [inputMessage]);

  // Initialize assessment with first question
  useEffect(() => {
    // Add initial AI message with first question
    setTimeout(() => {
      const initialMessage: ConversationMessage = {
        id: uuidv4(),
        sender: 'ai',
        message: "Welcome to your AI assessment! I'll be asking you questions over the next few minutes. Please ensure you remain visible on camera throughout the assessment. Let's begin with the first question.",
        timestamp: new Date()
      };
      setMessages([initialMessage]);
      
      // Speak the welcome message
      speakText(initialMessage.message, () => {
        // After welcome message, ask the first question
        setTimeout(() => {
          askQuestion(0);
        }, 1000);
      });
    }, 1000);
    
    // Initialize audio
    initializeAudio();
    
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
      
      // Stop any ongoing speech
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, [config.questions]);

  const initializeAudio = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        } 
      });
      
      streamRef.current = stream;
      
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4'
      });
      
      mediaRecorderRef.current = mediaRecorder;
      
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };
      
      mediaRecorder.onstop = () => {
        processAudioRecording();
      };
      
      // Initialize speech recognition
      initializeSpeechRecognition();
      
    } catch (error) {
      console.error('Error accessing microphone:', error);
      // Continue without showing error modal
    }
  };

  const initializeSpeechRecognition = () => {
    if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
      const SpeechRecognition = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;
      const recognition = new SpeechRecognition();
      
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'en-US';
      
      recognition.onresult = (event: any) => {
        let finalTranscript = '';
        let interimText = '';
        
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const transcript = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            finalTranscript += transcript;
          } else {
            interimText += transcript;
          }
        }
        
        if (interimText) {
          setInterimTranscript(interimText);
          
          // Show interim message
          const interimMessage: ConversationMessage = {
            id: 'interim-message',
            sender: 'candidate',
            message: interimText,
            timestamp: new Date(),
            isInterim: true
          };
          
          setMessages(prev => {
            const filtered = prev.filter(msg => msg.id !== 'interim-message');
            return [...filtered, interimMessage];
          });
        }
        
        if (finalTranscript) {
          handleSendMessage(finalTranscript);
          stopRecording();
        }
      };
      
      recognition.onerror = (event: any) => {
        console.error('Speech recognition error:', event.error);
      };
      
      recognition.onend = () => {
        setIsRecording(false);
      };
      
      speechRecognitionRef.current = recognition;
    }
  };

  const speakText = (text: string, onComplete?: () => void) => {
    if ('speechSynthesis' in window) {
      // Cancel any ongoing speech
      window.speechSynthesis.cancel();
      
      setIsAISpeaking(true);
      setIsMicMuted(true); // Mute mic when AI is speaking
      
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 0.9;
      utterance.pitch = 1;
      utterance.volume = 0.8;
      
      // Try to use a more natural voice
      const voices = speechSynthesis.getVoices();
      const preferredVoice = voices.find(voice => 
        voice.name.includes('Google') || 
        voice.name.includes('Microsoft') ||
        voice.name.includes('Natural')
      );
      
      if (preferredVoice) {
        utterance.voice = preferredVoice;
      }
      
      utterance.onend = () => {
        setIsAISpeaking(false);
        if (onComplete) {
          onComplete();
        }
      };
      
      utterance.onerror = () => {
        setIsAISpeaking(false);
        if (onComplete) {
          onComplete();
        }
      };
      
      speechSynthesisRef.current = utterance;
      window.speechSynthesis.speak(utterance);
    } else {
      setIsAISpeaking(false);
      if (onComplete) {
        onComplete();
      }
    }
  };

  const askQuestion = (questionIndex: number) => {
    if (questionIndex >= config.questions.length) {
      endAssessment('completed');
      return;
    }

    const question = config.questions[questionIndex];
    const questionMessage: ConversationMessage = {
      id: uuidv4(),
      sender: 'ai',
      message: question,
      timestamp: new Date()
    };

    setMessages(prev => [...prev, questionMessage]);
    setWaitingForUserResponse(false);
    
    speakText(question, () => {
      // After AI finishes speaking, allow user to respond
      setWaitingForUserResponse(true);
      setIsMicMuted(false); // Allow user to unmute after AI finishes
    });
  };

  const toggleMicrophone = () => {
    if (isAISpeaking) {
      // Don't allow unmuting while AI is speaking
      return;
    }

    if (isMicMuted) {
      // Unmute and start recording
      setIsMicMuted(false);
      startRecording();
    } else {
      // Mute and stop recording
      setIsMicMuted(true);
      stopRecording();
    }
  };

  const startRecording = () => {
    if (!speechRecognitionRef.current) {
      initializeSpeechRecognition();
    }
    
    if (speechRecognitionRef.current && !isAISpeaking) {
      setIsRecording(true);
      setInterimTranscript('');
      speechRecognitionRef.current.start();
    }
  };

  const stopRecording = () => {
    if (speechRecognitionRef.current) {
      speechRecognitionRef.current.stop();
    }
    setIsRecording(false);
  };

  const processAudioRecording = async () => {
    if (audioChunksRef.current.length === 0) return;
    
    try {
      const audioBlob = new Blob(audioChunksRef.current, { 
        type: 'audio/webm' 
      });
      
      // Simulate speech-to-text processing
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Mock transcript with auto-correction
      const mockTranscripts = [
        "I have over 5 years of experience in React development and I'm passionate about creating user-friendly interfaces.",
        "My background includes working with TypeScript, Node.js, and various cloud platforms like AWS.",
        "I enjoy collaborating with cross-functional teams and have led several successful projects from conception to deployment.",
        "I'm particularly interested in this role because it aligns with my career goals in frontend development.",
        "I believe my experience in agile development and problem-solving skills would be valuable to your team."
      ];
      
      // Select a random transcript
      let transcript = mockTranscripts[Math.floor(Math.random() * mockTranscripts.length)];
      
      // Apply auto-correction
      transcript = transcript
        .replace(/\bum\b|\buh\b|\ber\b|\blike\b|\byou know\b/gi, '') // Remove filler words
        .replace(/\s+/g, ' ') // Remove extra spaces
        .trim();
      
      // Add user message
      handleSendMessage(transcript);
      
    } catch (error) {
      console.error('Error processing audio:', error);
    }
  };

  const handleSendMessage = (message: string) => {
    if (!message.trim()) return;

    // Remove interim message
    setMessages(prev => prev.filter(msg => msg.id !== 'interim-message'));

    // Add user message
    const userMessage: ConversationMessage = {
      id: uuidv4(),
      sender: 'candidate',
      message: message,
      timestamp: new Date(),
      audioBlob: new Blob(audioChunksRef.current, { type: 'audio/webm' })
    };
    
    setMessages(prev => [...prev, userMessage]);
    setInputMessage('');
    setWaitingForUserResponse(false);
    
    // Clear audio chunks for next recording
    audioChunksRef.current = [];
    
    // Simulate AI thinking
    setIsTyping(true);
    
    // Determine if we should move to the next question or end the assessment
    setTimeout(() => {
      setIsTyping(false);
      
      const nextQuestionIndex = currentQuestionIndex + 1;
      
      // AI acknowledgment
      const acknowledgments = [
        "Thank you for your response. Let me ask you the next question.",
        "I appreciate your answer. Moving on to the next question.",
        "Great response. Here's your next question.",
        "Thank you. Let's continue with the next question.",
        "Excellent. Now for the next question."
      ];
      
      const randomAck = acknowledgments[Math.floor(Math.random() * acknowledgments.length)];
      
      const ackMessage: ConversationMessage = {
        id: uuidv4(),
        sender: 'ai',
        message: randomAck,
        timestamp: new Date()
      };
      
      setMessages(prev => [...prev, ackMessage]);
      
      speakText(randomAck, () => {
        // Move to next question after acknowledgment finishes
        setTimeout(() => {
          setCurrentQuestionIndex(nextQuestionIndex);
          
          if (nextQuestionIndex < config.questions.length) {
            askQuestion(nextQuestionIndex);
          } else {
            endAssessment('completed');
          }
        }, 1000);
      });
    }, 1500 + Math.random() * 1000);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage(inputMessage);
    }
  };

  const handleSecurityAlert = (alert: any) => {
    setSecurityAlerts(prev => [...prev, alert]);
    
    // Check if we need to terminate the assessment
    if (alert.severity === 'high' || securityAlerts.length >= config.maxViolations) {
      endAssessment('violation');
    }
  };

  const handleFaceDetectionUpdate = (data: FaceDetectionData) => {
    setFaceDetectionData(data);
  };

  const endAssessment = (reason: 'completed' | 'violation') => {
    // Stop recording if active
    if (isRecording) {
      stopRecording();
    }
    
    // Stop any ongoing speech
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    
    const assessmentResult = {
      questionsAnswered: currentQuestionIndex + 1,
      totalQuestions: config.questions.length,
      duration: Math.floor((Date.now() - assessmentStartTime) / 1000 / 60),
      securityAlertsCount: securityAlerts.length,
      securityAlerts,
      messages,
      terminationReason: reason === 'violation' ? 'Session terminated due to security violations' : null
    };
    
    // Add completion message
    const completionMessage = reason === 'completed' 
      ? "Thank you for completing the assessment! Your responses have been recorded and will be analyzed."
      : "The assessment has been terminated due to security violations.";
    
    const finalMessage: ConversationMessage = {
      id: uuidv4(),
      sender: 'ai',
      message: completionMessage,
      timestamp: new Date()
    };
    
    setMessages(prev => [...prev, finalMessage]);
    
    // Speak the completion message
    speakText(completionMessage, () => {
      // Complete assessment after message is spoken
      setTimeout(() => {
        onAssessmentComplete(assessmentResult);
      }, 2000);
    });
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 p-4 w-full">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="mb-6">
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">AI Interview</h1>
            <Badge variant="outline" className="text-sm">
              Question {currentQuestionIndex + 1} of {config.questions.length}
            </Badge>
          </div>
        </div>

        {/* Main Content */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Chat Panel */}
          <div className="lg:col-span-2">
            <Card className="h-[500px] sm:h-[600px] flex flex-col w-full">
              {/* Chat Header */}
              <div className="border-b border-gray-200 dark:border-gray-700 p-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-gradient-to-r from-blue-600 to-purple-600 rounded-full flex items-center justify-center">
                    <Bot className="w-6 h-6 text-white" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-gray-900 dark:text-white">AI Interviewer</h3>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      {isAISpeaking ? (
                        <span className="flex items-center gap-1">
                          <Volume2 className="w-4 h-4" />
                          <span>Speaking</span>
                        </span>
                      ) : isTyping ? (
                        <span className="flex items-center gap-1">
                          <span>Typing</span>
                          <div className="flex space-x-1">
                            <div className="w-1 h-1 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
                            <div className="w-1 h-1 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
                            <div className="w-1 h-1 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
                          </div>
                        </span>
                      ) : waitingForUserResponse ? (
                        <span>Waiting for your response</span>
                      ) : 'Ready to chat'}
                    </p>
                  </div>
                </div>
              </div>

              {/* Messages */}
              <div className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-thin scrollbar-thumb-gray-300 scrollbar-track-gray-100">
                {messages.map((message) => (
                  <div
                    key={message.id === 'interim-message' ? 'interim-message' : message.id}
                    className={`flex gap-3 ${message.sender === 'candidate' ? 'flex-row-reverse' : ''}`}
                  >
                    <div className={`
                      w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0
                      ${message.sender === 'ai' 
                        ? 'bg-gradient-to-r from-blue-600 to-purple-600' 
                        : 'bg-gray-600 dark:bg-gray-500'
                      }
                    `}>
                      {message.sender === 'ai' ? (
                        <Bot className="w-4 h-4 text-white" />
                      ) : (
                        <User className="w-4 h-4 text-white" />
                      )}
                    </div>
                    <div className={`
                      max-w-[85%] sm:max-w-[80%] p-3 rounded-lg
                      ${message.sender === 'ai' 
                        ? 'bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-white' 
                        : message.isInterim
                          ? 'bg-blue-400 text-white'
                          : 'bg-blue-600 text-white'
                      }
                    `}>
                      <p className="text-sm leading-relaxed whitespace-pre-wrap">
                        {message.message}
                        {message.isInterim && <span className="ml-1 animate-pulse">|</span>}
                      </p>
                      
                      {/* Audio playback for messages with audio */}
                      {message.audioBlob && (
                        <div className="mt-2 pt-2 border-t border-white/20">
                          <button
                            onClick={() => {
                              if (message.audioBlob) {
                                const audioUrl = URL.createObjectURL(message.audioBlob);
                                const audio = new Audio(audioUrl);
                                audio.play();
                              }
                            }}
                            className="flex items-center space-x-1 text-xs text-white/80 hover:text-white transition-colors"
                          >
                            <Volume2 className="h-3 w-3" />
                            <span>Play Audio</span>
                          </button>
                        </div>
                      )}
                      
                      <span className="text-xs opacity-70 mt-1 block">
                        {message.isInterim ? 'Speaking...' : new Date(message.timestamp).toLocaleTimeString([], { 
                          hour: '2-digit', 
                          minute: '2-digit' 
                        })}
                      </span>
                    </div>
                  </div>
                ))}
                
                {isTyping && (
                  <div className="flex gap-3">
                    <div className="w-8 h-8 bg-gradient-to-r from-blue-600 to-purple-600 rounded-full flex items-center justify-center">
                      <Bot className="w-4 h-4 text-white" />
                    </div>
                    <div className="bg-gray-100 dark:bg-gray-700 p-3 rounded-lg">
                      <div className="flex space-x-1">
                        <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
                        <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
                        <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
                      </div>
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Input */}
              <div className="p-4 border-t border-gray-200 dark:border-gray-700">
                <div className="flex gap-2">
                  <Button
                    onClick={toggleMicrophone}
                    variant={isRecording ? "destructive" : "outline"}
                    className="px-3"
                    disabled={isTyping || isAISpeaking || !waitingForUserResponse}
                  >
                    {isRecording ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
                  </Button>
                  <div className="flex-1">
                    <textarea
                      ref={textareaRef}
                      value={inputMessage}
                      onChange={(e) => setInputMessage(e.target.value)}
                      onKeyPress={handleKeyPress}
                      placeholder={waitingForUserResponse ? "Type your response..." : "Waiting for AI to finish..."}
                      className="w-full resize-none px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent min-h-[40px] max-h-[120px] bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                      rows={1}
                      disabled={isTyping || isRecording || isAISpeaking || !waitingForUserResponse}
                    />
                  </div>
                  <Button 
                    onClick={() => handleSendMessage(inputMessage)}
                    disabled={!inputMessage.trim() || isTyping || isAISpeaking || !waitingForUserResponse}
                    className="px-4"
                  >
                    <Send className="h-4 w-4" />
                  </Button>
                </div>
                
                {isRecording && (
                  <div className="mt-2 flex items-center justify-center gap-2 text-red-600">
                    <div className="w-3 h-3 bg-red-600 rounded-full animate-pulse"></div>
                    <span className="text-sm font-medium">Recording...</span>
                  </div>
                )}
                
                {isAISpeaking && (
                  <div className="mt-2 flex items-center justify-center gap-2 text-blue-600">
                    <Volume2 className="w-4 h-4" />
                    <span className="text-sm font-medium">AI is speaking... Please wait</span>
                  </div>
                )}
              </div>
            </Card>
          </div>

          {/* Side Panel */}
          <div className="space-y-6">
            {/* Progress */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Progress</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span>Completed</span>
                    <span>{currentQuestionIndex} / {config.questions.length}</span>
                  </div>
                  <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                    <div
                      className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                      style={{
                        width: `${(currentQuestionIndex / config.questions.length) * 100}%`
                      }}
                    ></div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Video Monitor */}
            <FloatingVideoMonitor 
              isActive={true}
              onSecurityAlert={handleSecurityAlert}
              onFaceDetectionUpdate={handleFaceDetectionUpdate}
              onFaceAwayViolation={() => {
                const result = {
                  questionsAnswered: currentQuestionIndex,
                  totalQuestions: config.questions.length,
                  duration: Math.floor((Date.now() - assessmentStartTime) / 1000 / 60),
                  securityAlertsCount: 2,
                  securityAlerts: [
                    {
                      id: Date.now().toString(),
                      type: 'face_not_detected',
                      message: 'Face not detected for 30 seconds (2/2)',
                      timestamp: new Date(),
                      severity: 'high'
                    }
                  ],
                  messages,
                  terminationReason: 'Session terminated: Looked away from camera twice'
                };
                onAssessmentComplete(result);
              }}
            />

            {/* Instructions */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Instructions</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-gray-600 dark:text-gray-400 space-y-2">
                <p>• Click the microphone icon to toggle recording</p>
                <p>• Or type your response in the text box</p>
                <p>• Keep your face visible to the camera</p>
                <p>• Answer all questions to complete the assessment</p>
                <p>• Stay focused on the screen during the assessment</p>
              </CardContent>
            </Card>
            
            {/* Audio Controls */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Audio Controls</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-gray-600 dark:text-gray-400">Microphone</span>
                    <Button
                      variant={isRecording ? "destructive" : "outline"}
                      size="sm"
                      onClick={toggleMicrophone}
                      disabled={isTyping || isAISpeaking || !waitingForUserResponse}
                    >
                      {isRecording ? <MicOff className="mr-2 h-4 w-4" /> : <Mic className="mr-2 h-4 w-4" />}
                      {isRecording ? 'Stop' : 'Start'}
                    </Button>
                  </div>
                  
                  {isRecording && (
                    <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-1.5">
                      <div className="bg-red-500 h-1.5 rounded-full animate-pulse w-full"></div>
                    </div>
                  )}
                  
                  {interimTranscript && (
                    <div className="p-2 bg-gray-100 dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700">
                      <p className="text-xs text-gray-600 dark:text-gray-400">
                        {interimTranscript}<span className="animate-pulse">|</span>
                      </p>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
};