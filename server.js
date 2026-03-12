import os
import requests
import pyperclip
import customtkinter as ctk
from dotenv import load_dotenv
import random

load_dotenv()

API_KEY = os.getenv("OPENROUTER_API_KEY")
MODEL = os.getenv("DEFAULT_MODEL", "anthropic/claude-3.5-sonnet")

class EmailApp(ctk.CTk):
    def __init__(self):
        super().__init__()

        self.title("SalesStack AI - Synthetic Thread Generator")
        self.geometry("600x950") 
        
        self.history = []
        self.total_target_emails = 0
        self.current_email_count = 0
        self.topics = ["Email Security", "Phishing Protection", "MDR/EDR", "Zero Trust", "Cloud Governance"]
        self.cultures = ["USA", "Vietnam", "Japan", "Germany", "UK", "Brazil", "Israel"]

        self.grid_columnconfigure(0, weight=1)

        ctk.CTkLabel(self, text="Thread Settings", font=("Arial", 24, "bold")).grid(row=0, column=0, pady=(20, 10))

        # Settings Group
        self.rep_level = self.create_dropdown("Sales Rep Skill (1-5)", ["1", "2", "3", "4", "5"], 1)
        self.exec_level = self.create_dropdown("Executive Seniority (1-5)", ["1", "2", "3", "4", "5"], 2)
        self.outcome = self.create_dropdown("Target Outcome", ["Win", "Lose", "Stalled/Nothing"], 3)
        self.origin_culture = self.create_dropdown("Rep Culture", self.cultures, 4)
        self.target_culture = self.create_dropdown("Prospect Culture", self.cultures, 5)
        
        # Total Emails
        ctk.CTkLabel(self, text="Total Number of Emails (Initial 6 + Future Steps)").grid(row=12, column=0, pady=(10, 0))
        self.thread_len_entry = ctk.CTkEntry(self, width=120, placeholder_text="e.g. 12")
        self.thread_len_entry.grid(row=13, column=0, pady=5)

        # Topic Override
        ctk.CTkLabel(self, text="Topic Override").grid(row=14, column=0, pady=(10, 0))
        self.topic_entry = ctk.CTkEntry(self, width=350, placeholder_text="Random Cybersecurity if blank")
        self.topic_entry.grid(row=15, column=0, pady=5)

        # Action Buttons
        self.gen_btn = ctk.CTkButton(self, text="Generate Initial 6 Emails", command=self.generate_initial, height=45, fg_color="#1f538d")
        self.gen_btn.grid(row=16, column=0, pady=25)

        self.next_btn = ctk.CTkButton(self, text="Next Email (Copy to Clipboard)", command=self.generate_next, state="disabled", height=45)
        self.next_btn.grid(row=17, column=0, pady=5)

        self.reset_btn = ctk.CTkButton(self, text="Reset / New Scenario", command=self.reset_app, height=30, fg_color="transparent", border_width=1)
        self.reset_btn.grid(row=18, column=0, pady=10)

        # Status Display
        self.status_label = ctk.CTkLabel(self, text="Ready", font=("Arial", 14), text_color="gray")
        self.status_label.grid(row=19, column=0, pady=20)

    def create_dropdown(self, label, values, row_idx):
        offset = row_idx * 2
        ctk.CTkLabel(self, text=label).grid(row=offset, column=0, pady=(10, 0))
        combo = ctk.CTkComboBox(self, values=values, width=220)
        combo.grid(row=offset+1, column=0, pady=2)
        return combo

    def call_llm(self, prompt):
        headers = {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}
        data = {"model": MODEL, "messages": [{"role": "user", "content": prompt}]}
        try:
            response = requests.post("https://openrouter.ai/api/v1/chat/completions", headers=headers, json=data)
            return response.json()['choices'][0]['message']['content']
        except Exception as e:
            return f"Error: {str(e)}"

    def generate_initial(self):
        # 1. READ THE USER INPUT FIRST
        raw_val = self.thread_len_entry.get().strip()
        if raw_val.isdigit():
            self.total_target_emails = int(raw_val)
        else:
            self.total_target_emails = random.randint(12, 24)

        # Ensure we aren't setting a limit lower than the initial drop
        if self.total_target_emails < 6:
            self.total_target_emails = 6

        self.status_label.configure(text="Thinking...", text_color="white")
        self.update()

        topic = self.topic_entry.get() if self.topic_entry.get() else random.choice(self.topics)
        self.current_email_count = 6
        
        prompt = f"""
        Generate the START of a professional sales email thread.
        Context: Rep ({self.origin_culture.get()}, Skill {self.rep_level.get()}/5) vs. Prospect ({self.target_culture.get()}, Level {self.exec_level.get()}/5).
        Topic: {topic}. Target Outcome: {self.outcome.get()}.
        Total thread length planned: {self.total_target_emails} emails.
        
        TASK: Write exactly the first 6 emails (3 rounds). 
        Format clearly with 'Email X' headers and '---' separators.
        """
        
        result = self.call_llm(prompt)
        self.history = [{"role": "assistant", "content": result}]
        pyperclip.copy(result)
        
        self.status_label.configure(text=f"First 6 Copied! Total length: {self.total_target_emails} emails.", text_color="#2ecc71")
        self.next_btn.configure(state="normal")

    def generate_next(self):
        # 2. CHECK THE LIMIT BEFORE CALLING
        if self.current_email_count >= self.total_target_emails:
            self.status_label.configure(text=f"Thread complete ({self.current_email_count} emails).", text_color="#e74c3c")
            self.next_btn.configure(state="disabled")
            return

        self.status_label.configure(text="Thinking...", text_color="white")
        self.update()

        history_text = "\n".join([m['content'] for m in self.history])
        
        prompt = f"""
        History: {history_text}
        Generate Email #{self.current_email_count + 1} ONLY.
        This is email {self.current_email_count + 1} of {self.total_target_emails}.
        Persona: Rep Skill {self.rep_level.get()}, Exec Seniority {self.exec_level.get()}. 
        Continue toward outcome: {self.outcome.get()} within the remaining {self.total_target_emails - self.current_email_count} emails.
        """
        
        new_email = self.call_llm(prompt)
        self.history.append({"role": "assistant", "content": new_email})
        self.current_email_count += 1
        pyperclip.copy(new_email)
        
        # Check again if we just hit the limit
        if self.current_email_count >= self.total_target_emails:
            self.status_label.configure(text=f"Email {self.current_email_count} Copied! (Thread Finished)", text_color="#2ecc71")
            self.next_btn.configure(state="disabled")
        else:
            self.status_label.configure(text=f"Email {self.current_email_count}/{self.total_target_emails} Copied!", text_color="#2ecc71")

    def reset_app(self):
        self.history = []
        self.current_email_count = 0
        self.total_target_emails = 0
        self.next_btn.configure(state="disabled")
        self.status_label.configure(text="Ready for new scenario", text_color="gray")

if __name__ == "__main__":
    app = EmailApp()
    app.mainloop()