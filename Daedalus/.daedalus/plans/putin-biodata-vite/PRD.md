# Product Requirements: Putin Biodata Website

## Users / Roles
- General public viewing a static informational page
- No authentication required

## Core Entities
- **Biodata**: Vladimir Putin's basic information (name, title, birth date, photo, career summary)

## Features

### F1: Display Basic Information
**WHEN** a user visits the site  
**THE SYSTEM SHALL** display:
- Full name: Vladimir Putin
- Current title: President of Russia
- Date of birth: October 7, 1952
- Professional photo
- Two-paragraph career summary covering KGB service and rise to presidency

### F2: Responsive Layout
**WHEN** the page is viewed on mobile, tablet, or desktop  
**THE SYSTEM SHALL** render a responsive layout that adapts to viewport width

## Scope / Non-goals

### In Scope
- Single-page static website with Putin's basic biographical data
- Responsive design (mobile-first)
- Professional presentation with photo
- Indonesian language content

### Non-goals
- Multi-page site or navigation
- Interactive features (comments, sharing)
- Dynamic data / CMS
- Multiple presidents or comparison
- Deep political history or analysis beyond brief career summary
- Internationalization (only Indonesian)

## Decisions
- **Data source**: Static content written directly into component (no external API)
- **Photo source**: Use openly-licensed photo from Wikimedia Commons or similar, downloaded into project
- **Language**: Indonesian (assumed from user's request language)
- **Styling**: Clean, professional, minimal design using basic CSS
