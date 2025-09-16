
// Initialize Firebase
firebase.initializeApp(window.firebaseConfig);
const db = firebase.firestore();
const auth = firebase.auth();
const storage = firebase.storage();

// Set persistence to LOCAL to keep user logged in across browser sessions
// Make sure this is called before any auth operations
auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).then(() => {
  // Wait a bit for persistence to take effect
  return new Promise(resolve => setTimeout(resolve, 100));
}).catch((error) => {
  return auth.setPersistence(firebase.auth.Auth.Persistence.SESSION);
}).then(() => {
  // Wait a bit for session persistence to take effect
  return new Promise(resolve => setTimeout(resolve, 100));
}).catch((fallbackError) => {
  // Continue without persistence
  return new Promise(resolve => setTimeout(resolve, 100));
});

const appDataDocRef = db.collection('appConfig').doc('data'); // Using a single document for all app data
    const usersCollection = db.collection('users'); // Collection for user management
    const operationsArchiveCollection = db.collection('operationsArchive'); // Collection for operations archive
    const exchangeCollection = db.collection('bookExchanges'); // Collection for book exchanges
    const notificationsCollection = db.collection('notifications'); // Collection for notifications
    const adminMessagesCollection = db.collection('adminMessages'); // Collection for admin messages
    const userReadMessagesCollection = db.collection('userReadMessages'); // Collection to track read messages

    // Current user state
    let currentUser = null;
    let isAdmin = false;

    let levels = []; // Initialize empty - will be loaded from Firebase
    let chosenBooks = {}; // {level: {book: count}} - now user-specific
    let currentLevelForAddBook = null; // Store the level index when adding a book
    let currentLevelIndex = null;
    let searchTerm = "";
    let userChosenBooksDocRef = null; // Reference to user's chosen books document
    
    // Notifications system variables
    let notifications = [];
    let unreadNotifications = 0;
    let notificationsLoaded = 0;
    let notificationsPerPage = 8;
    let notificationsListener = null;
    let isNotificationsDropdownOpen = false;
    
    // Admin messages system variables
    let adminMessagesListener = null;
    let pendingAdminMessages = [];
    let userReadMessages = new Set();
    
    // Messages system variables (separate from notifications)
    let messages = [];
    let unreadMessages = 0;
    let messagesLoaded = 0;
    let messagesPerPage = 8;
    let messagesListener = null;
    let isMessagesDropdownOpen = false;

    async function saveData() {
      // 1. Save levels to shared app data (admin only)
      if (isAdmin) {
        try {
        await appDataDocRef.set({ levels }, { merge: true });
      } catch (error) {
        // Error saving levels to Firebase
      }
      }

      // 2. Save user's chosen books to their personal document
      if (currentUser && userChosenBooksDocRef) {
        try {
          await userChosenBooksDocRef.set({ chosenBooks });
        } catch (error) {
          // Error saving chosen books to Firebase
        }
      }

      // 3. Save to localStorage (user-specific) - with fallback
      try {
        const userKey = currentUser ? `bookAppData_${currentUser.uid}` : 'bookAppData_guest';
        localStorage.setItem(userKey, JSON.stringify({ chosenBooks }));
        localStorage.setItem('bookAppData_levels', JSON.stringify({ levels }));
      } catch (e) {
        // Try sessionStorage as fallback
        try {
          const userKey = currentUser ? `bookAppData_${currentUser.uid}` : 'bookAppData_guest';
          sessionStorage.setItem(userKey, JSON.stringify({ chosenBooks }));
          sessionStorage.setItem('bookAppData_levels', JSON.stringify({ levels }));
        } catch (sessionError) {
          // Data only saved to Firebase
        }
      }
    }

    // دالة معاينة الصورة في نموذج التبادل
    function previewExchangeBookImage(input) {
      const preview = document.getElementById('exchangeBookImagePreview');
      const previewImg = document.getElementById('exchangeBookImagePreviewImg');
      
      if (input.files && input.files[0]) {
        const reader = new FileReader();
        
        reader.onload = function(e) {
          previewImg.src = e.target.result;
          preview.style.display = 'block';
        };
        
        reader.readAsDataURL(input.files[0]);
      } else {
        preview.style.display = 'none';
      }
    }
    
    // دالة إزالة صورة الكتاب في نموذج التبادل
    function removeExchangeBookImage() {
      document.getElementById('exchangeBookImage').value = '';
      document.getElementById('exchangeBookImagePreview').style.display = 'none';
    }
    
    // دالة إضافة كتاب جديد إلى المستوى إذا لم يكن موجوداً
    async function addBookToLevelIfNotExists(bookName, levelName, imageUrl) {
      try {
        // البحث عن المستوى
        const levelIndex = levels.findIndex(level => level.name === levelName);
        if (levelIndex === -1) return;
        
        // التحقق من وجود الكتاب
        if (!levels[levelIndex].books) {
          levels[levelIndex].books = [];
        }
        
        if (!levels[levelIndex].books.includes(bookName)) {
          // إضافة الكتاب إلى المستوى
          levels[levelIndex].books.push(bookName);
          levels[levelIndex].books = sortBooks(levels[levelIndex].books);
          
          // إضافة صورة الكتاب إذا كانت متوفرة
          if (imageUrl) {
            if (!levels[levelIndex].bookImages) {
              levels[levelIndex].bookImages = {};
            }
            levels[levelIndex].bookImages[bookName] = imageUrl;
          }
          
          // حفظ البيانات
          await saveData();
          
          // تحديث العرض إذا كان المستوى مفتوحاً حالياً
          if (currentLevelIndex === levelIndex) {
            renderBooksList();
          }
        }
      } catch (error) {
        console.error('Error adding book to level:', error);
      }
    }

    // دالة معاينة الصورة قبل الرفع
    function previewBookImage(input) {
      const preview = document.getElementById('imagePreview');
      const previewImg = document.getElementById('previewImg');
      
      if (input.files && input.files[0]) {
        const file = input.files[0];
        
        // التحقق من حجم الصورة (أقل من 1MB)
        if (file.size > 1024 * 1024) {
          showTemporaryAlert('حجم الصورة يجب أن يكون أقل من 1 ميجابايت', 'error');
          input.value = '';
          preview.style.display = 'none';
          return;
        }
        
        const reader = new FileReader();
        
        reader.onload = function(e) {
          previewImg.src = e.target.result;
          preview.style.display = 'block';
        };
        
        reader.readAsDataURL(file);
      } else {
        preview.style.display = 'none';
      }
    }

    // دالة رفع صورة الكتاب إلى Firebase Storage
    async function uploadBookImage(file, bookName) {
      if (!file) return null;
      
      try {
        const timestamp = Date.now();
        // استخدام مسار مبسط للاختبار
        const fileName = `images/${timestamp}-${bookName.replace(/[^a-zA-Z0-9]/g, '_')}.${file.name.split('.').pop()}`;
        const storageRef = storage.ref(fileName);
        
        const snapshot = await storageRef.put(file);
        const downloadURL = await snapshot.ref.getDownloadURL();
        
        return downloadURL;
      } catch (error) {
        console.error('Error uploading image:', error);
        showTemporaryAlert('خطأ في رفع الصورة. تأكد من صلاحيات Firebase Storage', 'error');
        throw error;
      }
    }

    // دالة عرض الصورة في النافذة المنبثقة
    function showImageModal(imageUrl, bookName) {
      const modal = document.getElementById('imageModal');
      const img = document.getElementById('imageModalImg');
      const title = document.getElementById('imageModalTitle');
      
      img.src = imageUrl;
      title.textContent = `صورة الكتاب: ${bookName}`;
      modal.style.display = 'flex';
    }

    // دالة عرض نافذة إضافة صورة للكتاب
    function showAddImageModal(bookName, levelIndex) {
      const modal = document.createElement('div');
      modal.className = 'image-modal';
      modal.style.display = 'flex';
      modal.innerHTML = `
        <div class="image-modal-content">
          <span class="image-modal-close" onclick="this.parentElement.parentElement.remove()">&times;</span>
          <h3 class="image-modal-title">إضافة صورة للكتاب: ${bookName}</h3>
          <form id="addImageForm">
            <div style="margin-bottom: 15px;">
              <label for="bookImageFile">اختر صورة الكتاب:</label>
              <input type="file" id="bookImageFile" accept="image/*" required style="margin-top: 5px; width: 100%;">
            </div>
            <div id="imagePreviewContainer" style="display: none; margin-bottom: 15px; text-align: center;">
              <img id="imagePreview" style="max-width: 200px; max-height: 200px; border-radius: 8px;">
            </div>
            <div style="text-align: center;">
              <button type="submit" style="background: #48bb78; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin-right: 10px;">إضافة الصورة</button>
              <button type="button" onclick="this.closest('.image-modal').remove()" style="background: #e53e3e; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer;">إلغاء</button>
            </div>
          </form>
        </div>
      `;
      
      document.body.appendChild(modal);
      
      // معالج معاينة الصورة
      const fileInput = modal.querySelector('#bookImageFile');
      const previewContainer = modal.querySelector('#imagePreviewContainer');
      const previewImg = modal.querySelector('#imagePreview');
      
      fileInput.onchange = function(e) {
        const file = e.target.files[0];
        if (file) {
          if (file.size > 1024 * 1024) {
            showTemporaryAlert('حجم الصورة يجب أن يكون أقل من 1 ميجابايت', 'error');
            fileInput.value = '';
            previewContainer.style.display = 'none';
            return;
          }
          
          const reader = new FileReader();
          reader.onload = function(e) {
            previewImg.src = e.target.result;
            previewContainer.style.display = 'block';
          };
          reader.readAsDataURL(file);
        } else {
          previewContainer.style.display = 'none';
        }
      };
      
      // معالج إرسال النموذج
      modal.querySelector('#addImageForm').onsubmit = async function(e) {
        e.preventDefault();
        
        const file = fileInput.files[0];
        if (!file) {
          showTemporaryAlert('يرجى اختيار صورة', 'error');
          return;
        }
        
        try {
          showTemporaryAlert('جاري رفع الصورة...', 'info');
          
          const imageUrl = await uploadBookImage(file, bookName);
          
          // إضافة الصورة إلى بيانات المستوى
          if (!levels[levelIndex].booksWithImages) {
            levels[levelIndex].booksWithImages = {};
          }
          levels[levelIndex].booksWithImages[bookName] = imageUrl;
          
          // حفظ في Firestore
          if (isAdmin || (currentUser && currentUser.canEditContent)) {
            await appDataDocRef.set({ levels }, { merge: true });
            await addToArchive('add', 'book_image', `إضافة صورة للكتاب "${bookName}" من المستوى "${levels[levelIndex].name}"`);
          }
          
          showTemporaryAlert('تم إضافة الصورة بنجاح', 'success');
          renderBooksList();
          modal.remove();
        } catch (error) {
          console.error('Error adding image:', error);
          showTemporaryAlert('حدث خطأ في إضافة الصورة', 'error');
        }
      };
    }

    // دالة عرض نافذة تعديل صورة الكتاب
    function showEditImageModal(bookName, levelIndex) {
      // البحث عن رابط الصورة الحالي في كلا المكانين
      let currentImageUrl = null;
      if (levels[levelIndex].booksWithImages && levels[levelIndex].booksWithImages[bookName]) {
        currentImageUrl = levels[levelIndex].booksWithImages[bookName];
      } else if (levels[levelIndex].bookImages && levels[levelIndex].bookImages[bookName]) {
        currentImageUrl = levels[levelIndex].bookImages[bookName];
      }
      
      const modal = document.createElement('div');
      modal.className = 'image-modal';
      modal.style.display = 'flex';
      modal.innerHTML = `
        <div class="image-modal-content">
          <span class="image-modal-close" onclick="this.parentElement.parentElement.remove()">&times;</span>
          <h3 class="image-modal-title">تعديل صورة الكتاب: ${bookName}</h3>
          <div style="text-align: center; margin-bottom: 15px;">
            <p>الصورة الحالية:</p>
            <img src="${currentImageUrl}" style="max-width: 200px; max-height: 200px; border-radius: 8px; border: 2px solid #ddd;">
          </div>
          <form id="editImageForm">
            <div style="margin-bottom: 15px;">
              <label for="newBookImageFile">اختر صورة جديدة:</label>
              <input type="file" id="newBookImageFile" accept="image/*" required style="margin-top: 5px; width: 100%;">
            </div>
            <div id="newImagePreviewContainer" style="display: none; margin-bottom: 15px; text-align: center;">
              <p>الصورة الجديدة:</p>
              <img id="newImagePreview" style="max-width: 200px; max-height: 200px; border-radius: 8px; border: 2px solid #48bb78;">
            </div>
            <div style="text-align: center;">
              <button type="submit" style="background: #4299e1; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin-right: 10px;">تحديث الصورة</button>
              <button type="button" onclick="this.closest('.image-modal').remove()" style="background: #e53e3e; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer;">إلغاء</button>
            </div>
          </form>
        </div>
      `;
      
      document.body.appendChild(modal);
      
      // معالج معاينة الصورة الجديدة
      const fileInput = modal.querySelector('#newBookImageFile');
      const previewContainer = modal.querySelector('#newImagePreviewContainer');
      const previewImg = modal.querySelector('#newImagePreview');
      
      fileInput.onchange = function(e) {
        const file = e.target.files[0];
        if (file) {
          if (file.size > 1024 * 1024) {
            showTemporaryAlert('حجم الصورة يجب أن يكون أقل من 1 ميجابايت', 'error');
            fileInput.value = '';
            previewContainer.style.display = 'none';
            return;
          }
          
          const reader = new FileReader();
          reader.onload = function(e) {
            previewImg.src = e.target.result;
            previewContainer.style.display = 'block';
          };
          reader.readAsDataURL(file);
        } else {
          previewContainer.style.display = 'none';
        }
      };
      
      // معالج إرسال النموذج
      modal.querySelector('#editImageForm').onsubmit = async function(e) {
        e.preventDefault();
        
        const file = fileInput.files[0];
        if (!file) {
          showTemporaryAlert('يرجى اختيار صورة جديدة', 'error');
          return;
        }
        
        try {
          showTemporaryAlert('جاري تحديث الصورة...', 'info');
          
          const newImageUrl = await uploadBookImage(file, bookName);
          
          // تحديث الصورة في بيانات المستوى
          levels[levelIndex].booksWithImages[bookName] = newImageUrl;
          
          // حفظ في Firestore
          if (isAdmin || (currentUser && currentUser.canEditContent)) {
            await appDataDocRef.set({ levels }, { merge: true });
            await addToArchive('edit', 'book_image', `تعديل صورة الكتاب "${bookName}" من المستوى "${levels[levelIndex].name}"`);
          }
          
          // تحديث جميع الإعلانات المرتبطة بهذا الكتاب
          await updateExchangeImageUrls(bookName, levels[levelIndex].name, newImageUrl);
          
          showTemporaryAlert('تم تحديث الصورة بنجاح', 'success');
          renderBooksList();
          
          // إعادة تحميل الإعلانات لعرض الصورة المحدثة
          if (typeof loadExchangeListings === 'function') {
            loadExchangeListings(currentExchangeType);
          }
          
          modal.remove();
        } catch (error) {
          console.error('Error updating image:', error);
          showTemporaryAlert('حدث خطأ في تحديث الصورة', 'error');
        }
      };
    }

    // دالة حذف صورة الكتاب
    async function deleteBookImage(bookName, levelIndex) {
      if (!confirm(`هل تريد حذف صورة الكتاب "${bookName}"؟`)) {
        return;
      }
      
      try {
        // حذف الصورة من البيانات
        if (levels[levelIndex].booksWithImages && levels[levelIndex].booksWithImages[bookName]) {
          delete levels[levelIndex].booksWithImages[bookName];
        }
        
        // حفظ في Firestore
        if (isAdmin || (currentUser && currentUser.canEditContent)) {
          await appDataDocRef.set({ levels }, { merge: true });
          await addToArchive('delete', 'book_image', `حذف صورة الكتاب "${bookName}" من المستوى "${levels[levelIndex].name}"`);
        }
        
        showTemporaryAlert('تم حذف الصورة بنجاح', 'success');
        renderBooksList();
      } catch (error) {
        console.error('Error deleting image:', error);
        showTemporaryAlert('حدث خطأ في حذف الصورة', 'error');
      }
    }

    // دالة إغلاق النافذة المنبثقة للصورة
    function closeImageModal() {
      const modal = document.getElementById('imageModal');
      if (modal) {
        modal.style.display = 'none';
      }
    }

    // دالة عرض نافذة إضافة كتاب
    function showAddBookModal(levelIndex) {
      currentLevelForAddBook = levelIndex;
      document.getElementById('addBookModal').style.display = 'flex';
      document.getElementById('addBookForm').reset();
      document.getElementById('imagePreview').style.display = 'none';
    }

    // دالة إغلاق نافذة إضافة كتاب
    function closeAddBookModal() {
      document.getElementById('addBookModal').style.display = 'none';
      document.getElementById('addBookForm').reset();
      document.getElementById('imagePreview').style.display = 'none';
      currentLevelForAddBook = null;
    }

    // معالج نموذج إضافة الكتاب
    async function handleAddBookSubmit(e) {
      e.preventDefault();
      
      const bookName = document.getElementById('bookName').value.trim();
      const imageFile = document.getElementById('bookImage').files[0];
      
      if (!bookName) {
        showTemporaryAlert('يرجى إدخال اسم الكتاب', 'error');
        return;
      }
      
      if (currentLevelForAddBook === null) {
        showTemporaryAlert('خطأ في تحديد المستوى', 'error');
        return;
      }
      
      // التحقق من عدم وجود كتاب بنفس الاسم
      if (levels[currentLevelForAddBook].books.includes(bookName)) {
        showTemporaryAlert('الكتاب موجود بالفعل!', 'error');
        return;
      }
      
      try {
        showTemporaryAlert('جاري إضافة الكتاب...', 'info');
        
        let imageUrl = null;
        
        // رفع الصورة إذا كانت موجودة
        if (imageFile) {
          imageUrl = await uploadBookImage(imageFile, bookName);
        }
        
        // إضافة الكتاب مع الصورة إلى المصفوفة المحلية
        const bookData = {
          name: bookName,
          imageUrl: imageUrl
        };
        
        // تحديث بنية البيانات لتشمل الصور
        if (!levels[currentLevelForAddBook].booksWithImages) {
          levels[currentLevelForAddBook].booksWithImages = {};
        }
        
        levels[currentLevelForAddBook].books.push(bookName);
        levels[currentLevelForAddBook].books = sortBooks(levels[currentLevelForAddBook].books);
        
        if (imageUrl) {
          levels[currentLevelForAddBook].booksWithImages[bookName] = imageUrl;
        }
        
        // حفظ في Firestore
        await appDataDocRef.set({ levels }, { merge: true });
        
        // إضافة العملية إلى الأرشيف
        await addToArchive('add', 'book', `إضافة الكتاب "${bookName}" إلى المستوى "${levels[currentLevelForAddBook].name}"`);
        
        // تحديث الواجهة
        renderBooksList();
        closeAddBookModal();
        showTemporaryAlert('تم إضافة الكتاب بنجاح!', 'success');
        
        // حفظ في التخزين المحلي كنسخة احتياطية
        localStorage.setItem('bookAppData_levels', JSON.stringify({ levels }));
        
      } catch (error) {
        console.error('خطأ في إضافة الكتاب:', error);
        showTemporaryAlert('حدث خطأ في إضافة الكتاب. يرجى المحاولة مرة أخرى', 'error');
      }
    }

    function renderLevels() {
      const levelsList = document.getElementById('levelsList');
      levelsList.innerHTML = '';
      levels.forEach((level, idx) => {
        const btn = document.createElement('button');
        btn.className = 'level-btn';
        btn.textContent = level.name;
        btn.onclick = () => openBooksModal(idx);
        levelsList.appendChild(btn);
      });
    }

         function openBooksModal(idx) {
       currentLevelIndex = idx;
       const modal = document.getElementById('booksModal');
       const content = document.getElementById('booksModalContent');
       const level = levels[idx];
       const hasEditPermission = isAdmin || (currentUser && currentUser.canEditContent);
       
       content.innerHTML = `
         <span class="close-btn" onclick="closeBooksModal()">&times;</span>
         <h3 style="color:#667eea;">الكتب الخاصة بمستوى: ${level.name}</h3>
         <input class="search-input" id="searchBookInput" placeholder="ابحث عن كتاب..." oninput="searchBooks()" />
         <div class="books-list" id="booksList"></div>
         ${hasEditPermission ? `
           <button class="add-book-btn" id="addBookBtn" onclick="addBookToLevel()">
             ➕ إضافة كتاب جديد
           </button>
         ` : ''}
       `;
       modal.style.display = 'flex';
       renderBooksList();
       updateAdminUI(); // Update admin-only buttons visibility
     }

    function closeBooksModal() {
      document.getElementById('booksModal').style.display = 'none';
      searchTerm = "";
    }

         function renderBooksList() {
       const booksListDiv = document.getElementById('booksList');
       const currentLevel = levels[currentLevelIndex];
       let books = currentLevel.books;
       if (searchTerm) {
         books = books.filter(b => b.toLowerCase().includes(searchTerm.toLowerCase()));
       }
       
       booksListDiv.innerHTML = '';
       books.forEach(book => {
        const btn = document.createElement('div');
        btn.className = 'book-btn';
        const levelName = currentLevel.name;
        const count = (chosenBooks[levelName] && chosenBooks[levelName][book]) ? chosenBooks[levelName][book] : 0;
        if (count > 0) btn.classList.add('selected');
        
        // إنشاء حاوي العنوان
        const titleContainer = document.createElement('div');
        titleContainer.className = 'book-title-container';
        
        const titleSpan = document.createElement('span');
        titleSpan.className = 'book-title';
        titleSpan.textContent = book;
        titleContainer.appendChild(titleSpan);
        btn.appendChild(titleContainer);

        const controlsDiv = document.createElement('div');
        controlsDiv.className = 'book-controls';
 
 
         // أزرار إدارة الصور (للمديرين والمحررين)
         const hasEditPermission = isAdmin || (currentUser && currentUser.canEditContent);
         
         // البحث عن صورة الكتاب في كلا المكانين
         let bookImageUrl = null;
         if (currentLevel.booksWithImages && currentLevel.booksWithImages[book]) {
           bookImageUrl = currentLevel.booksWithImages[book];
         } else if (currentLevel.bookImages && currentLevel.bookImages[book]) {
           bookImageUrl = currentLevel.bookImages[book];
         }
         
         if (bookImageUrl) {
           // زر عرض الصورة
           const viewImageBtn = document.createElement('button');
           viewImageBtn.className = 'view-image-btn';
           viewImageBtn.textContent = '👁️';
           viewImageBtn.title = 'عرض صورة الكتاب';
           viewImageBtn.onclick = (e) => {
             e.stopPropagation();
             showImageModal(bookImageUrl, book);
           };
           controlsDiv.appendChild(viewImageBtn);
           
           if (hasEditPermission) {
             // زر تعديل الصورة
             const editImageBtn = document.createElement('button');
             editImageBtn.className = 'edit-image-btn';
             editImageBtn.textContent = '✏️';
             editImageBtn.title = 'تعديل صورة الكتاب';
             editImageBtn.onclick = (e) => {
               e.stopPropagation();
               showEditImageModal(book, currentLevelIndex);
             };
             controlsDiv.appendChild(editImageBtn);
             
             // زر حذف الصورة
             const deleteImageBtn = document.createElement('button');
             deleteImageBtn.className = 'delete-image-btn';
             deleteImageBtn.textContent = '🗑️';
             deleteImageBtn.title = 'حذف صورة الكتاب';
             deleteImageBtn.onclick = (e) => {
               e.stopPropagation();
               deleteBookImage(book, currentLevelIndex);
             };
             controlsDiv.appendChild(deleteImageBtn);
           }
         } else if (hasEditPermission) {
           // زر إضافة صورة للكتب التي لا تحتوي على صورة
           const addImageBtn = document.createElement('button');
           addImageBtn.className = 'add-image-btn';
           addImageBtn.textContent = '📷';
           addImageBtn.title = 'إضافة صورة للكتاب';
           addImageBtn.onclick = (e) => {
             e.stopPropagation();
             showAddImageModal(book, currentLevelIndex);
           };
           controlsDiv.appendChild(addImageBtn);
         }

         // زر حذف كتاب (للمديرين والمحررين)
         if (hasEditPermission) {
           const deleteBookBtn = document.createElement('button');
           deleteBookBtn.className = 'remove-book-btn';
           deleteBookBtn.textContent = 'حذف';
                     deleteBookBtn.onclick = async (e) => {
             e.stopPropagation();
             if (confirm(`هل تريد حذف الكتاب "${book}"؟`)) {
              try {
                // حذف الكتاب محلياً
               levels[currentLevelIndex].books = levels[currentLevelIndex].books.filter(b => b !== book);
               if (chosenBooks[currentLevel.name]) delete chosenBooks[currentLevel.name][book];
               
               // حذف الصورة من البيانات إذا كانت موجودة
               if (levels[currentLevelIndex].booksWithImages && levels[currentLevelIndex].booksWithImages[book]) {
                 delete levels[currentLevelIndex].booksWithImages[book];
               }
                
                // حفظ التغييرات في Firestore مباشرة
                if (isAdmin || (currentUser && currentUser.canEditContent)) {
                  await appDataDocRef.set({ levels }, { merge: true });
                  
                  // إضافة العملية إلى الأرشيف
                  await addToArchive('delete', 'book', `حذف الكتاب "${book}" من المستوى "${currentLevel.name}"`);
                  
                  showTemporaryAlert('تم حذف الكتاب بنجاح وتحديث قاعدة البيانات', 'success');
                } else {
                  showTemporaryAlert('ليس لديك صلاحية لحذف الكتب', 'error');
                  return;
                }
                
                // تحديث الواجهة
               renderBooksList();
               saveData();
               renderChosenBooksTables();
              } catch (error) {
                console.error("خطأ في حذف الكتاب:", error);
                showTemporaryAlert("حدث خطأ في حذف الكتاب. يرجى المحاولة مرة أخرى", "error");
                
                // إعادة الكتاب محلياً في حالة فشل الحذف
                const levelBooks = levels[currentLevelIndex].books;
                if (!levelBooks.includes(book)) {
                  levelBooks.push(book);
                  levels[currentLevelIndex].books = sortBooks(levelBooks);
                  renderBooksList();
                }
              }
             }
           };
           controlsDiv.appendChild(deleteBookBtn);
         }
 
         // زر ناقص
         const minusBtn = document.createElement('button');
         minusBtn.className = 'minus-btn';
         minusBtn.textContent = '−';
         minusBtn.onclick = (e) => {
           e.stopPropagation();
           if (count > 0) {
             chosenBooks[levels[currentLevelIndex].name][book] = count - 1;
             if (chosenBooks[levels[currentLevelIndex].name][book] === 0) {
               delete chosenBooks[levels[currentLevelIndex].name][book];
             }
             renderBooksList();
             renderChosenBooksTables();
             saveData();
           }
         };
         controlsDiv.appendChild(minusBtn);

         // العدد
         const countDiv = document.createElement('span');
         countDiv.className = 'book-count';
         countDiv.textContent = count;
         controlsDiv.appendChild(countDiv);

         // حقل إدخال الكمية يدوياً
         const quantityInput = document.createElement('input');
         quantityInput.type = 'number';
         quantityInput.className = 'quantity-input';
         quantityInput.placeholder = 'كمية';
         quantityInput.min = '1';
         quantityInput.max = '999';
         quantityInput.style.width = '60px';
         quantityInput.onclick = (e) => e.stopPropagation();
         controlsDiv.appendChild(quantityInput);

         // زر إضافة الكمية المحددة
         const addQuantityBtn = document.createElement('button');
         addQuantityBtn.className = 'add-quantity-btn';
         addQuantityBtn.textContent = 'إضافة';
         addQuantityBtn.onclick = (e) => {
           e.stopPropagation();
           const quantity = parseInt(quantityInput.value);
           if (quantity && quantity > 0) {
             addBookQuantity(book, quantity);
             quantityInput.value = '';
           } else {
             showTemporaryAlert('يرجى إدخال كمية صحيحة', 'error');
           }
         };
         controlsDiv.appendChild(addQuantityBtn);
 
         btn.appendChild(controlsDiv);
         btn.onclick = () => selectBook(book);
         booksListDiv.appendChild(btn);
       });
       
       // تم إلغاء خيار عرض المزيد وعرض أقل - الآن تظهر جميع الكتب مباشرة
    }

    function searchBooks() {
      searchTerm = document.getElementById('searchBookInput').value.trim();
      renderBooksList();
    }

         async function addBookToLevel() {
       const hasEditPermission = isAdmin || (currentUser && currentUser.canEditContent);
       if (!hasEditPermission) {
         showTemporaryAlert("ليس لديك صلاحية لإضافة كتاب", "error");
         return;
       }

       // استخدام النافذة المنبثقة الجديدة
       showAddBookModal(currentLevelIndex);
     }

    function selectBook(book) {
      const levelName = levels[currentLevelIndex].name;
      if (!chosenBooks[levelName]) chosenBooks[levelName] = {};
      if (!chosenBooks[levelName][book]) chosenBooks[levelName][book] = 0;
      chosenBooks[levelName][book]++;
      saveData();
      renderBooksList();
      renderChosenBooksTables();
    }

    function addBookQuantity(book, quantity) {
      const levelName = levels[currentLevelIndex].name;
      if (!chosenBooks[levelName]) chosenBooks[levelName] = {};
      if (!chosenBooks[levelName][book]) chosenBooks[levelName][book] = 0;
      chosenBooks[levelName][book] += quantity;
      saveData();
      renderBooksList();
      renderChosenBooksTables();
    }

    function renderChosenBooksTables() {
      const div = document.getElementById('chosenBooksTables');
      div.innerHTML = '';
      // Iterate through the main 'levels' array to ensure the correct order of display.
      levels.forEach(level => {
        const levelName = level.name;
        const books = chosenBooks[levelName];

        // If there are no chosen books for this specific level, skip it.
        if (!books || Object.keys(books).length === 0) {
          return;
        }

        let html = `<div style="text-align:center; margin-top:30px; margin-bottom:20px;">
          <h3 style="color:#4a5568; margin:0; padding:10px 20px; background:linear-gradient(135deg, #f7fafc 0%, #e2e8f0 100%); color:#4a5568; border-radius:25px; display:inline-block; box-shadow:0 4px 15px rgba(160, 174, 192, 0.2); font-weight:600; letter-spacing:1px;">${levelName}</h3>
          <div style="width:80px; height:3px; background:linear-gradient(90deg, #cbd5e0, #a0aec0); margin:8px auto; border-radius:2px;"></div>
        </div>
        <table class="chosen-books-table">
          <tr>
            <th>الكتاب</th>
            <th>العدد</th>
            <th>إزالة</th>
          </tr>`;
        // Sort the books alphabetically within each table for better organization.
        Object.keys(books).sort((a, b) => a.localeCompare(b, 'ar')).forEach(book => {
          html += `<tr>
            <td>${book}</td>
            <td>
              <input type="number" class="table-quantity-input" value="${books[book]}" min="1" max="999" 
                     onchange="updateBookQuantity('${levelName}','${book}', this.value)" 
                     onclick="this.select()">
            </td>
            <td>
              <button class="remove-book-btn" onclick="removeBook('${levelName}','${book}')">حذف</button>
            </td>
          </tr>`;
        });
        html += `</table>`;
        div.innerHTML += html;
      });
    }

    function changeBookCount(levelName, book, delta) {
      if (!chosenBooks[levelName]) return;
      let newCount = (chosenBooks[levelName][book] || 0) + delta;
      if (newCount < 0) newCount = 0;
      chosenBooks[levelName][book] = newCount;
      if (newCount === 0) delete chosenBooks[levelName][book];
      saveData();
      renderChosenBooksTables();
      if (currentLevelIndex !== null) renderBooksList();
    }

    function updateBookQuantity(levelName, book, newQuantity) {
      const quantity = parseInt(newQuantity);
      if (isNaN(quantity) || quantity < 1) {
        showTemporaryAlert('يرجى إدخال كمية صحيحة (1 أو أكثر)', 'error');
        renderChosenBooksTables(); // Reset the input field
        return;
      }
      
      if (!chosenBooks[levelName]) chosenBooks[levelName] = {};
      chosenBooks[levelName][book] = quantity;
      saveData();
      renderChosenBooksTables();
      if (currentLevelIndex !== null) renderBooksList();
    }

    function removeBook(levelName, book) {
      if (confirm(`هل تريد حذف الكتاب "${book}" من المستوى "${levelName}"؟`)) {
        delete chosenBooks[levelName][book];
        if (Object.keys(chosenBooks[levelName]).length === 0) delete chosenBooks[levelName];
        saveData();
        renderChosenBooksTables();
        renderBooksList();
      }
    }

    function clearAllChosenBooks() {
      // Check if there are any books to clear
      if (Object.keys(chosenBooks).length === 0 || Object.values(chosenBooks).every(books => Object.keys(books).length === 0)) {
        alert("لا توجد كتب مختارة لمسحها.");
        return;
      }

      if (confirm("هل أنت متأكد من أنك تريد مسح جميع الكتب المختارة؟ هذا الإجراء لا يمكن التراجع عنه.")) {
        chosenBooks = {};
        saveData(); // Save the cleared state
        // Re-render the UI
        renderChosenBooksTables();
        if (currentLevelIndex !== null && document.getElementById('booksModal').style.display === 'flex') {
          renderBooksList();
        }
      }
    }

    // وظائف النسخ الاحتياطي القديمة - تم تعديلها لتكون متاحة فقط للمدير
    function exportJSON() {
      // التحقق من صلاحيات المدير
      if (!isAdmin) {
        showTemporaryAlert('هذه الخاصية متاحة فقط للمدير', 'error');
        return;
      }
      
      try {
        // 1. إعداد البيانات للتصدير
        const dataToExport = {
          levels: levels,
          chosenBooks: chosenBooks
        };

        // 2. تحويل البيانات إلى نص JSON منسق
        const jsonString = JSON.stringify(dataToExport, null, 2);

        // 3. إنشاء Blob (Binary Large Object)
        const blob = new Blob([jsonString], { type: 'application/json;charset=utf-8;' });

        // 4. إنشاء رابط تحميل مؤقت
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const date = new Date().toISOString().slice(0, 10);
        a.download = `بيانات-الكتب-${date}.json`;

        // 5. تفعيل التحميل
        document.body.appendChild(a);
        a.click();

        // 6. تنظيف الرابط المؤقت
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch (error) {
        console.error('Error exporting JSON:', error);
        showTemporaryAlert("حدث خطأ أثناء تصدير البيانات.", "error");
      }
    }

    function importJSON() {
      // التحقق من صلاحيات المدير
      if (!isAdmin) {
        showTemporaryAlert('هذه الخاصية متاحة فقط للمدير', 'error');
        return;
      }
      
      // This function simply triggers the hidden file input
      document.getElementById('json-import-input').click();
    }

    function handleJSONImport(event) {
        // التحقق من صلاحيات المدير
        if (!isAdmin) {
          showTemporaryAlert('هذه الخاصية متاحة فقط للمدير', 'error');
          event.target.value = null;
          return;
        }
        
        const file = event.target.files[0];
        if (!file) {
            return;
        }

        const reader = new FileReader();
        reader.onload = function(e) {
            try {
                const data = JSON.parse(e.target.result);

                // Basic validation
                if (typeof data === 'object' && data !== null && Array.isArray(data.levels) && typeof data.chosenBooks === 'object') {
                    if (confirm("هل أنت متأكد من استيراد البيانات؟ سيتم استبدال جميع البيانات الحالية.")) {
                        levels = data.levels;
                        chosenBooks = data.chosenBooks || {}; // Ensure chosenBooks is at least an empty object
                        saveData(); // Save the new data to Firebase and localStorage
                        showTemporaryAlert("تم استيراد البيانات بنجاح! سيتم تحديث الواجهة.", "success");
                    }
                } else {
                    showTemporaryAlert("ملف JSON غير صالح أو لا يحتوي على البنية المطلوبة (levels, chosenBooks).", "error");
                }
            } catch (error) {
                console.error('Error importing JSON:', error);
                showTemporaryAlert("حدث خطأ أثناء قراءة الملف. تأكد من أنه ملف JSON صالح.", "error");
            } finally {
                event.target.value = null; // Reset input to allow re-importing the same file
            }
        };
        reader.readAsText(file);
    }

    // الأزرار القديمة تم نقلها إلى الشريط الجانبي - لا حاجة لهذا الكود
    // document.getElementById('levelsSettingsBtn').onclick = function() {
    //   renderLevelsSettingsModal();
    //   document.getElementById('levelsSettingsModal').style.display = 'flex';
    // };
    
    // document.getElementById('adminMessageBtn').onclick = function() {
    //   if (isAdmin) {
    //     showAdminMessageModal();
    //   } else {
    //     showTemporaryAlert('هذه الخاصية متاحة فقط للمدير', 'error');
    //   }
    // };
    
    // document.getElementById('contactAdminBtn').onclick = function() {
    //   if (currentUser) {
    //     showContactAdminModal();
    //   } else {
    //     showTemporaryAlert('يجب تسجيل الدخول أولاً', 'error');
    //   }
    // };
    
    // عرض نافذة راسل الإدارة
    function showContactAdminModal() {
      document.getElementById('contactAdminModal').style.display = 'flex';
      
      // إعداد معالج الحدث للنموذج
      document.getElementById('contactAdminForm').onsubmit = async function(e) {
        e.preventDefault();
        
        const title = document.getElementById('contactAdminTitle').value.trim();
        const message = document.getElementById('contactAdminMessage').value.trim();
        const attachmentFile = document.getElementById('contactAdminAttachment').files[0];
        
        if (!title || !message) {
          showTemporaryAlert('يرجى ملء جميع الحقول', 'error');
          return;
        }
        
        try {
          showTemporaryAlert('جاري إرسال الرسالة...', 'info');
          await sendMessageToAdmin(title, message, attachmentFile);
          const attachmentText = attachmentFile ? ' مع مرفق' : '';
          showTemporaryAlert(`تم إرسال الرسالة${attachmentText} للإدارة بنجاح`, 'success');
          closeContactAdminModal();
        } catch (error) {
          console.error('Error sending message to admin:', error);
          showTemporaryAlert('حدث خطأ في إرسال الرسالة', 'error');
        }
      };
    }
    
    // إغلاق نافذة راسل الإدارة
    function closeContactAdminModal() {
      document.getElementById('contactAdminModal').style.display = 'none';
      document.getElementById('contactAdminForm').reset();
      document.getElementById('contactAttachmentPreview').style.display = 'none';
    }
    
    // إرسال رسالة للإدارة
    async function sendMessageToAdmin(title, message, attachmentFile = null) {
      if (!currentUser) return;
      
      // الحصول على بيانات المستخدم من Firestore للحصول على رقم الهاتف
      let userPhone = '';
      try {
        const userDoc = await usersCollection.doc(currentUser.uid).get();
        if (userDoc.exists) {
          userPhone = userDoc.data().phone || '';
        }
      } catch (error) {
        console.warn('Could not fetch user phone:', error);
      }
      
      let attachmentData = null;
      
      // Upload attachment if provided
      if (attachmentFile) {
        const attachmentUrl = await uploadMessageAttachment(attachmentFile);
        if (attachmentUrl) {
          attachmentData = {
            name: attachmentFile.name,
            size: attachmentFile.size,
            type: attachmentFile.type,
            url: attachmentUrl,
            isImage: attachmentFile.type.startsWith('image/')
          };
        }
      }
      
      const userMessage = {
        title: title,
        message: message,
        attachment: attachmentData,
        fromUserId: currentUser.uid,
        fromUserName: currentUser.name || currentUser.displayName || currentUser.email,
        fromUserEmail: currentUser.email,
        fromUserPhone: userPhone,
        timestamp: firebase.firestore.FieldValue.serverTimestamp(),
        isRead: false,
        type: 'user_to_admin'
      };
      
      // حفظ الرسالة في مجموعة الرسائل الإدارية
      await adminMessagesCollection.add(userMessage);
    }
    
    // إعداد معالجات الأحداث لنماذج إعدادات الحساب
    function setupAccountSettingsFormHandlers() {
      // أزرار النسخ الاحتياطي والاستعادة
      const backupBtn = document.getElementById('backupBtn');
      const restoreBtn = document.getElementById('restoreBtn');
      
      if (backupBtn) {
        backupBtn.onclick = createBackup;
      }
      
      if (restoreBtn) {
        restoreBtn.onclick = restoreBackup;
      }
      // نموذج تحديث معلومات الحساب
      document.getElementById('accountSettingsForm').onsubmit = async function(e) {
        e.preventDefault();
        
        const name = document.getElementById('accountName').value.trim();
        const phone = document.getElementById('accountPhone').value.trim();
        
        if (!name) {
          showTemporaryAlert('يرجى إدخال الاسم الكامل', 'error');
          return;
        }
        
        try {
          // تحديث معلومات المستخدم في Firebase
          await usersCollection.doc(currentUser.uid).update({
            name: name,
            phone: phone
          });
          
          // تحديث المعلومات محلياً
          if (currentUser) {
            currentUser.name = name;
            currentUser.phone = phone;
            
            // تحديث اسم العرض في Firebase Auth
            if (auth.currentUser) {
              await auth.currentUser.updateProfile({
                displayName: name
              });
            }
          }
          
          showTemporaryAlert('تم تحديث معلومات الحساب بنجاح', 'success');
          
          // تحديث اسم المستخدم في الواجهة
          document.getElementById('welcome-text').textContent = `مرحباً ${name}`;
        } catch (error) {
          console.error('Error updating account info:', error);
          showTemporaryAlert('حدث خطأ في تحديث معلومات الحساب', 'error');
        }
      };
      
      // نموذج تغيير كلمة المرور
      document.getElementById('passwordChangeForm').onsubmit = async function(e) {
        e.preventDefault();
        
        const currentPassword = document.getElementById('currentPassword').value;
        const newPassword = document.getElementById('newPassword').value;
        const confirmPassword = document.getElementById('confirmPassword').value;
        
        if (!currentPassword || !newPassword || !confirmPassword) {
          showTemporaryAlert('يرجى ملء جميع الحقول', 'error');
          return;
        }
        
        if (newPassword !== confirmPassword) {
          showTemporaryAlert('كلمة المرور الجديدة وتأكيدها غير متطابقين', 'error');
          return;
        }
        
        if (newPassword.length < 6) {
          showTemporaryAlert('يجب أن تكون كلمة المرور الجديدة 6 أحرف على الأقل', 'error');
          return;
        }
        
        try {
          // إعادة المصادقة باستخدام كلمة المرور الحالية
          const credential = firebase.auth.EmailAuthProvider.credential(
            currentUser.email,
            currentPassword
          );
          
          await auth.currentUser.reauthenticateWithCredential(credential);
          
          // تغيير كلمة المرور
          await auth.currentUser.updatePassword(newPassword);
          
          showTemporaryAlert('تم تغيير كلمة المرور بنجاح', 'success');
          
          // إعادة تعيين النموذج
          document.getElementById('passwordChangeForm').reset();
        } catch (error) {
          showArchiveModal();
        };
      }
    }
    
    // عرض نافذة الأرشيف
    async function showArchiveModal() {
      if (!isAdmin) {
        showTemporaryAlert('فقط المدير يمكنه الوصول إلى الأرشيف', 'error');
        return;
      }
      
      document.getElementById('archiveModal').style.display = 'flex';
      
      // تحديد الزر النشط
      document.getElementById('allOperationsBtn').classList.add('active');
      
      // تحميل بيانات الأرشيف
      await loadArchiveData('all');
    }
    
    // إغلاق نافذة الأرشيف
    function closeArchiveModal() {
      document.getElementById('archiveModal').style.display = 'none';
    }
    
    // تصفية الأرشيف حسب النوع (المستويات أو الكتب أو الكل)
    async function filterArchive(type) {
      // تحديد الزر النشط
      document.querySelectorAll('#allOperationsBtn, #levelsOperationsBtn, #booksOperationsBtn').forEach(btn => {
        btn.classList.remove('active');
      });
      
      document.getElementById(type + 'OperationsBtn').classList.add('active');
      
      // تحميل البيانات المصفاة
      await loadArchiveData(type);
    }
    
    // تصفية الأرشيف حسب العملية (إضافة أو تعديل أو حذف)
    async function filterArchiveByAction(action) {
      // تحديد الزر النشط
      document.querySelectorAll('#addOperationsBtn, #editOperationsBtn, #deleteOperationsBtn').forEach(btn => {
        btn.classList.remove('active');
      });
      
      document.getElementById(action + 'OperationsBtn').classList.add('active');
      
      // تحميل البيانات المصفاة
      await loadArchiveData(null, action);
    }
    
    // تحميل بيانات الأرشيف
    async function loadArchiveData(type = 'all', action = null) {
      const tableBody = document.getElementById('archiveTableBody');
      tableBody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 20px;">جاري تحميل البيانات...</td></tr>';
      
      try {
        // Get all data first, then filter client-side to avoid composite index requirement
        let query = operationsArchiveCollection.orderBy('timestamp', 'desc').limit(500);
        
        const snapshot = await query.get();
        
        if (snapshot.empty) {
          tableBody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 20px;">لا توجد عمليات مسجلة</td></tr>';
          return;
        }
        
        // Filter results client-side
        let filteredDocs = snapshot.docs;
        
        // تطبيق التصفية حسب النوع
        if (type === 'levels') {
          filteredDocs = filteredDocs.filter(doc => doc.data().entityType === 'level');
        } else if (type === 'books') {
          filteredDocs = filteredDocs.filter(doc => doc.data().entityType === 'book');
        }
        
        // تطبيق التصفية حسب العملية
        if (action === 'add') {
          filteredDocs = filteredDocs.filter(doc => doc.data().actionType === 'add');
        } else if (action === 'edit') {
          filteredDocs = filteredDocs.filter(doc => doc.data().actionType === 'edit');
        } else if (action === 'delete') {
          filteredDocs = filteredDocs.filter(doc => doc.data().actionType === 'delete');
        }
        
        // Limit to 100 results after filtering
        filteredDocs = filteredDocs.slice(0, 100);
        
        if (filteredDocs.length === 0) {
          tableBody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 20px;">لا توجد عمليات مسجلة</td></tr>';
          return;
        }
        
        tableBody.innerHTML = '';
        
        filteredDocs.forEach(doc => {
          const operation = doc.data();
          const date = operation.timestamp ? new Date(operation.timestamp.toDate()) : new Date();
          const formattedDate = `${date.getDate()}/${date.getMonth() + 1}/${date.getFullYear()} ${date.getHours()}:${date.getMinutes()}`;
          
          let actionTypeText = '';
          if (operation.actionType === 'add') actionTypeText = 'إضافة';
          else if (operation.actionType === 'edit') actionTypeText = 'تعديل';
          else if (operation.actionType === 'delete') actionTypeText = 'حذف';
          
          let entityTypeText = '';
          if (operation.entityType === 'level') entityTypeText = 'مستوى دراسي';
          else if (operation.entityType === 'book') entityTypeText = 'كتاب';
          
          const row = document.createElement('tr');
          row.style.borderBottom = '1px solid #e2e8f0';
          
          row.innerHTML = `
            <td style="padding: 10px; text-align: center;">${formattedDate}</td>
            <td style="padding: 10px; text-align: center;">${actionTypeText}</td>
            <td style="padding: 10px; text-align: center;">${entityTypeText}</td>
            <td style="padding: 10px; text-align: right;">${operation.details}</td>
            <td style="padding: 10px; text-align: center;">${operation.userName}</td>
            <td style="padding: 10px; text-align: center;">
              <button onclick="deleteArchiveOperation('${doc.id}')" 
                      style="background-color: #e53e3e; color: white; border: none; padding: 5px 10px; border-radius: 4px; cursor: pointer; font-size: 12px;"
                      onmouseover="this.style.backgroundColor='#c53030'" 
                      onmouseout="this.style.backgroundColor='#e53e3e'">
                حذف
              </button>
            </td>
          `;
          
          tableBody.appendChild(row);
        });
      } catch (error) {
        console.error('Error loading archive data:', error);
        tableBody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 20px; color: red;">حدث خطأ في تحميل البيانات</td></tr>';
      }
    }
    
    // إضافة عملية جديدة إلى الأرشيف
    async function addToArchive(actionType, entityType, details) {
      if (!currentUser) return;
      
      try {
        const archiveEntry = {
          actionType: actionType, // 'add', 'edit', 'delete'
          entityType: entityType, // 'level', 'book'
          details: details,
          userId: currentUser.uid,
          userName: currentUser.name || currentUser.displayName || currentUser.email,
          timestamp: firebase.firestore.FieldValue.serverTimestamp()
        };
        
        await operationsArchiveCollection.add(archiveEntry);
      } catch (error) {
        console.error('Error adding to archive:', error);
      }
    }
    
    // حذف عملية من الأرشيف (للمدير فقط)
    async function deleteArchiveOperation(operationId) {
      if (!isAdmin) {
        showTemporaryAlert('فقط المدير يمكنه حذف العمليات من الأرشيف', 'error');
        return;
      }
      
      // تأكيد الحذف
      if (!confirm('هل أنت متأكد من حذف هذه العملية من الأرشيف؟\nلا يمكن التراجع عن هذا الإجراء.')) {
        return;
      }
      
      try {
        // حذف العملية من Firestore
        await operationsArchiveCollection.doc(operationId).delete();
        
        showTemporaryAlert('تم حذف العملية من الأرشيف بنجاح', 'success');
        
        // إعادة تحميل بيانات الأرشيف لتحديث الجدول
        const activeFilter = document.querySelector('#allOperationsBtn.active, #levelsOperationsBtn.active, #booksOperationsBtn.active');
        const activeAction = document.querySelector('#addOperationsBtn.active, #editOperationsBtn.active, #deleteOperationsBtn.active');
        
        let filterType = 'all';
        if (activeFilter && activeFilter.id === 'levelsOperationsBtn') filterType = 'levels';
        else if (activeFilter && activeFilter.id === 'booksOperationsBtn') filterType = 'books';
        
        let actionType = null;
        if (activeAction && activeAction.id === 'addOperationsBtn') actionType = 'add';
        else if (activeAction && activeAction.id === 'editOperationsBtn') actionType = 'edit';
        else if (activeAction && activeAction.id === 'deleteOperationsBtn') actionType = 'delete';
        
        await loadArchiveData(filterType, actionType);
        
      } catch (error) {
        console.error('Error deleting archive operation:', error);
        showTemporaryAlert('حدث خطأ في حذف العملية من الأرشيف', 'error');
      }
    }
    
    // حذف جميع العمليات المعروضة من الأرشيف (للمدير فقط)
    async function deleteAllArchiveOperations() {
      if (!isAdmin) {
        showTemporaryAlert('فقط المدير يمكنه حذف العمليات من الأرشيف', 'error');
        return;
      }
      
      // الحصول على الفلاتر النشطة
      const activeFilter = document.querySelector('#allOperationsBtn.active, #levelsOperationsBtn.active, #booksOperationsBtn.active');
      const activeAction = document.querySelector('#addOperationsBtn.active, #editOperationsBtn.active, #deleteOperationsBtn.active');
      
      let filterType = 'all';
      if (activeFilter && activeFilter.id === 'levelsOperationsBtn') filterType = 'levels';
      else if (activeFilter && activeFilter.id === 'booksOperationsBtn') filterType = 'books';
      
      let actionType = null;
      if (activeAction && activeAction.id === 'addOperationsBtn') actionType = 'add';
      else if (activeAction && activeAction.id === 'editOperationsBtn') actionType = 'edit';
      else if (activeAction && activeAction.id === 'deleteOperationsBtn') actionType = 'delete';
      
      // تحديد نص التأكيد بناءً على الفلاتر
      let confirmMessage = 'هل أنت متأكد من حذف جميع العمليات';
      if (filterType === 'levels') confirmMessage += ' الخاصة بالمستويات الدراسية';
      else if (filterType === 'books') confirmMessage += ' الخاصة بالكتب';
      
      if (actionType === 'add') confirmMessage += ' (عمليات الإضافة فقط)';
      else if (actionType === 'edit') confirmMessage += ' (عمليات التعديل فقط)';
      else if (actionType === 'delete') confirmMessage += ' (عمليات الحذف فقط)';
      
      confirmMessage += ' من الأرشيف؟\n\n⚠️ تحذير: هذا الإجراء لا يمكن التراجع عنه وسيحذف جميع العمليات المعروضة نهائياً!';
      
      // تأكيد مزدوج للحذف
      if (!confirm(confirmMessage)) {
        return;
      }
      
      if (!confirm('تأكيد أخير: هل أنت متأكد 100% من حذف جميع العمليات المعروضة؟\nهذا الإجراء نهائي ولا يمكن التراجع عنه!')) {
        return;
      }
      
      try {
        // الحصول على العمليات المطابقة للفلاتر
        let query = operationsArchiveCollection.orderBy('timestamp', 'desc');
        
        const snapshot = await query.get();
        
        if (snapshot.empty) {
          showTemporaryAlert('لا توجد عمليات للحذف', 'info');
          return;
        }
        
        // تصفية العمليات حسب الفلاتر النشطة
        let operationsToDelete = snapshot.docs;
        
        if (filterType === 'levels') {
          operationsToDelete = operationsToDelete.filter(doc => doc.data().entityType === 'level');
        } else if (filterType === 'books') {
          operationsToDelete = operationsToDelete.filter(doc => doc.data().entityType === 'book');
        }
        
        if (actionType === 'add') {
          operationsToDelete = operationsToDelete.filter(doc => doc.data().actionType === 'add');
        } else if (actionType === 'edit') {
          operationsToDelete = operationsToDelete.filter(doc => doc.data().actionType === 'edit');
        } else if (actionType === 'delete') {
          operationsToDelete = operationsToDelete.filter(doc => doc.data().actionType === 'delete');
        }
        
        if (operationsToDelete.length === 0) {
          showTemporaryAlert('لا توجد عمليات مطابقة للفلاتر المحددة للحذف', 'info');
          return;
        }
        
        // حذف العمليات في مجموعات (batch delete)
        const batchSize = 500; // Firestore batch limit
        let deletedCount = 0;
        
        for (let i = 0; i < operationsToDelete.length; i += batchSize) {
          const batch = db.batch();
          const batchOperations = operationsToDelete.slice(i, i + batchSize);
          
          batchOperations.forEach(doc => {
            batch.delete(operationsArchiveCollection.doc(doc.id));
          });
          
          await batch.commit();
          deletedCount += batchOperations.length;
        }
        
        showTemporaryAlert(`تم حذف ${deletedCount} عملية من الأرشيف بنجاح`, 'success');
        
        // إعادة تحميل بيانات الأرشيف
        await loadArchiveData(filterType, actionType);
        
      } catch (error) {
        console.error('Error deleting all archive operations:', error);
        showTemporaryAlert('حدث خطأ في حذف العمليات من الأرشيف', 'error');
      }
    }
    
    // عرض نافذة إعدادات الحساب الشخصي
    function showAccountSettingsModal() {
      document.getElementById('accountSettingsModal').style.display = 'flex';
      
      // ملء بيانات المستخدم
      if (currentUser) {
        document.getElementById('accountName').value = currentUser.name || currentUser.displayName || '';
        document.getElementById('accountEmail').value = currentUser.email || '';
        document.getElementById('accountPhone').value = currentUser.phone || '';
      }
      
      // إظهار قسم إعدادات المدير للمدراء فقط
      const adminSettingsSection = document.getElementById('adminSettingsSection');
      if (adminSettingsSection) {
        adminSettingsSection.style.display = isAdmin ? 'block' : 'none';
      }
      
      // إعداد معالجات الأحداث
      setupAccountSettingsFormHandlers();
    }
    
    // إعداد معالجات الأحداث لنافذة إعدادات الحساب
    function setupAccountSettingsFormHandlers() {
      // معالج نموذج تحديث بيانات الحساب
      const accountForm = document.getElementById('accountSettingsForm');
      if (accountForm) {
        accountForm.onsubmit = async function(e) {
          e.preventDefault();
          
          const name = document.getElementById('accountName').value.trim();
          const phone = document.getElementById('accountPhone').value.trim();
          
          if (!name) {
            showTemporaryAlert('يرجى إدخال الاسم الكامل', 'error');
            return;
          }
          
          try {
            await usersCollection.doc(currentUser.uid).update({
              name: name,
              phone: phone
            });
            
            // تحديث بيانات المستخدم المحلية
            currentUser.name = name;
            currentUser.phone = phone;
            
            showTemporaryAlert('تم تحديث بيانات الحساب بنجاح', 'success');
          } catch (error) {
            console.error('Error updating account:', error);
            showTemporaryAlert('حدث خطأ في تحديث البيانات', 'error');
          }
        };
      }
      
      // معالج نموذج تغيير كلمة المرور
      const passwordForm = document.getElementById('passwordChangeForm');
      if (passwordForm) {
        passwordForm.onsubmit = async function(e) {
          e.preventDefault();
          
          const currentPassword = document.getElementById('currentPassword').value;
          const newPassword = document.getElementById('newPassword').value;
          const confirmPassword = document.getElementById('confirmPassword').value;
          
          if (newPassword !== confirmPassword) {
            showTemporaryAlert('كلمة المرور الجديدة وتأكيدها غير متطابقين', 'error');
            return;
          }
          
          if (newPassword.length < 6) {
            showTemporaryAlert('كلمة المرور يجب أن تكون 6 أحرف على الأقل', 'error');
            return;
          }
          
          try {
            const credential = firebase.auth.EmailAuthProvider.credential(
              currentUser.email,
              currentPassword
            );
            
            await currentUser.reauthenticateWithCredential(credential);
            await currentUser.updatePassword(newPassword);
            
            showTemporaryAlert('تم تغيير كلمة المرور بنجاح', 'success');
            passwordForm.reset();
          } catch (error) {
            console.error('Error changing password:', error);
            if (error.code === 'auth/wrong-password') {
              showTemporaryAlert('كلمة المرور الحالية غير صحيحة', 'error');
            } else {
              showTemporaryAlert('حدث خطأ في تغيير كلمة المرور', 'error');
            }
          }
        };
      }
    }

    // إغلاق نافذة إعدادات الحساب الشخصي
    function closeAccountSettingsModal() {
      document.getElementById('accountSettingsModal').style.display = 'none';
    }
    
    // إغلاق نافذة إعدادات المستويات الدراسية
    function closeLevelsSettingsModal() {
      document.getElementById('levelsSettingsModal').style.display = 'none';
    }
    
    // عرض نافذة إعدادات المستويات الدراسية
    function renderLevelsSettingsModal() {
      const listDiv = document.getElementById('levelsSettingsList');
      listDiv.innerHTML = '';
      
      // التحقق من صلاحيات المستخدم
      const hasEditPermission = isAdmin || (currentUser && currentUser.canEditContent);
      
      if (!hasEditPermission) {
        listDiv.innerHTML = '<div style="text-align: center; color: #e53e3e; padding: 20px;">ليس لديك صلاحية لتعديل المستويات الدراسية</div>';
        document.getElementById('addLevelSettingsBtn').style.display = 'none';
        return;
      }
      
      // عرض قائمة المستويات
      document.getElementById('addLevelSettingsBtn').style.display = 'block';
      document.getElementById('addLevelSettingsBtn').onclick = addLevelFromSettings;
      
      levels.forEach((level, idx) => {
        const div = document.createElement('div');
        div.style.marginBottom = '10px';
        div.innerHTML = `
          <input type="text" value="${level.name}" onchange="changeLevelName(${idx},this.value)" />
          <button class="move-up" onclick="moveLevelUp(${idx})">↑</button>
          <button class="move-down" onclick="moveLevelDown(${idx})">↓</button>
          <button class="delete-level" onclick="deleteLevel(${idx})">حذف</button>
        `;
        listDiv.appendChild(div);
      });
      
      document.getElementById('json-import-input').onchange = handleJSONImport;
    }
         async function addLevelFromSettings() {
       const hasEditPermission = isAdmin || (currentUser && currentUser.canEditContent);
       if (!hasEditPermission) {
         showTemporaryAlert("ليس لديك صلاحية لإضافة مستوى دراسي", "error");
         return;
       }

       const levelName = prompt("أدخل اسم المستوى الدراسي الجديد:");
       if (levelName && levelName.trim()) {
         const trimmedLevelName = levelName.trim();
         
         // التحقق من عدم وجود مستوى بنفس الاسم
         if (levels.some(level => level.name === trimmedLevelName)) {
           showTemporaryAlert("يوجد مستوى دراسي بهذا الاسم بالفعل!", "error");
           return;
         }

         try {
           // إضافة المستوى محلياً
           levels.push({ name: trimmedLevelName, books: [] });
           
           // حفظ في Firestore
           await appDataDocRef.set({ levels }, { merge: true });
           
           // إضافة العملية إلى الأرشيف
           await addToArchive('add', 'level', `إضافة مستوى دراسي جديد: ${trimmedLevelName}`);
           
           // تحديث الواجهة
           renderLevels();
           renderLevelsSettingsModal();
           showTemporaryAlert("تم إضافة المستوى الدراسي بنجاح وسيظهر لجميع المستخدمين", "success");
           
           // حفظ في التخزين المحلي كنسخة احتياطية
           localStorage.setItem('bookAppData_levels', JSON.stringify({ levels }));
         } catch (error) {
           console.error("خطأ في حفظ المستوى الدراسي:", error);
           showTemporaryAlert("حدث خطأ في حفظ المستوى الدراسي. يرجى المحاولة مرة أخرى", "error");
           
           // إزالة المستوى محلياً إذا فشل الحفظ
           levels.pop();
         }
       }
     }
         window.changeLevelName = async function(idx, val) {
       const hasEditPermission = isAdmin || (currentUser && currentUser.canEditContent);
       if (!hasEditPermission) {
         showTemporaryAlert("ليس لديك صلاحية لتغيير اسم المستوى", "error");
         return;
       }

       const oldName = levels[idx].name;
       const newName = val.trim();
       
       // التحقق من عدم وجود مستوى بنفس الاسم
       if (levels.some((level, i) => i !== idx && level.name === newName)) {
         showTemporaryAlert("يوجد مستوى دراسي بهذا الاسم بالفعل!", "error");
         renderLevelsSettingsModal(); // إعادة تحميل الواجهة بالاسم القديم
         return;
       }

       try {
         // تحديث الاسم محلياً
         if (val !== oldName && chosenBooks[oldName]) {
           chosenBooks[newName] = chosenBooks[oldName];
           delete chosenBooks[oldName];
         }
         levels[idx].name = newName;
         
         // حفظ في Firestore
         await appDataDocRef.set({ levels }, { merge: true });
         
         // تحديث الواجهة
         renderLevels();
         renderLevelsSettingsModal();
         renderChosenBooksTables();
         showTemporaryAlert("تم تغيير اسم المستوى بنجاح وسيظهر لجميع المستخدمين", "success");
         
         // حفظ في التخزين المحلي
         localStorage.setItem('bookAppData_levels', JSON.stringify({ levels }));
         
         // حفظ الكتب المختارة المحدثة
         if (currentUser && userChosenBooksDocRef) {
           await userChosenBooksDocRef.set({ chosenBooks });
         }
       } catch (error) {
         console.error("خطأ في تحديث اسم المستوى:", error);
         showTemporaryAlert("حدث خطأ في حفظ التغييرات. يرجى المحاولة مرة أخرى", "error");
         
         // استعادة الاسم القديم
         levels[idx].name = oldName;
         if (chosenBooks[newName]) {
           chosenBooks[oldName] = chosenBooks[newName];
           delete chosenBooks[newName];
         }
         renderLevelsSettingsModal();
       }
     };
         window.moveLevelUp = async function(idx) {
       const hasEditPermission = isAdmin || (currentUser && currentUser.canEditContent);
       if (!hasEditPermission) {
         showTemporaryAlert("ليس لديك صلاحية لتغيير ترتيب المستويات", "error");
         return;
       }

       if (idx === 0) {
         showTemporaryAlert("هذا المستوى في الأعلى بالفعل", "error");
         return;
       }

       try {
         // تحريك المستوى محلياً
         [levels[idx-1], levels[idx]] = [levels[idx], levels[idx-1]];
         
         // حفظ في Firestore
         await appDataDocRef.set({ levels }, { merge: true });
         
         // تحديث الواجهة
         renderLevels();
         renderLevelsSettingsModal();
         renderChosenBooksTables();
         showTemporaryAlert("تم تحريك المستوى للأعلى وسيظهر التغيير لجميع المستخدمين", "success");
         
         // حفظ في التخزين المحلي
         localStorage.setItem('bookAppData_levels', JSON.stringify({ levels }));
       } catch (error) {
         console.error("خطأ في تحريك المستوى:", error);
         showTemporaryAlert("حدث خطأ في حفظ التغييرات. يرجى المحاولة مرة أخرى", "error");
         
         // استعادة الترتيب القديم
         [levels[idx-1], levels[idx]] = [levels[idx], levels[idx-1]];
         renderLevelsSettingsModal();
       }
     };
         window.moveLevelDown = async function(idx) {
       const hasEditPermission = isAdmin || (currentUser && currentUser.canEditContent);
       if (!hasEditPermission) {
         showTemporaryAlert("ليس لديك صلاحية لتغيير ترتيب المستويات", "error");
         return;
       }

       if (idx === levels.length-1) {
         showTemporaryAlert("هذا المستوى في الأسفل بالفعل", "error");
         return;
       }

       try {
         // تحريك المستوى محلياً
         [levels[idx+1], levels[idx]] = [levels[idx], levels[idx+1]];
         
         // حفظ في Firestore
         await appDataDocRef.set({ levels }, { merge: true });
         
         // تحديث الواجهة
         renderLevels();
         renderLevelsSettingsModal();
         renderChosenBooksTables();
         showTemporaryAlert("تم تحريك المستوى للأسفل وسيظهر التغيير لجميع المستخدمين", "success");
         
         // حفظ في التخزين المحلي
         localStorage.setItem('bookAppData_levels', JSON.stringify({ levels }));
       } catch (error) {
         console.error("خطأ في تحريك المستوى:", error);
         showTemporaryAlert("حدث خطأ في حفظ التغييرات. يرجى المحاولة مرة أخرى", "error");
         
         // استعادة الترتيب القديم
         [levels[idx+1], levels[idx]] = [levels[idx], levels[idx+1]];
         renderLevelsSettingsModal();
       }
     };
    window.deleteLevel = async function(idx) {
      const hasEditPermission = isAdmin || (currentUser && currentUser.canEditContent);
      if (!hasEditPermission) {
        showTemporaryAlert("ليس لديك صلاحية لحذف المستويات", "error");
        return;
      }

      const levelName = levels[idx].name;
      if (confirm(`هل أنت متأكد من حذف المستوى "${levelName}"؟\nسيؤدي ذلك إلى:\n- حذف جميع الكتب في هذا المستوى\n- إزالة المستوى من قوائم جميع المستخدمين`)) {
        try {
          // حفظ نسخة احتياطية
          const oldLevels = [...levels];
          const oldChosenBooks = {...chosenBooks};
          
          // حذف المستوى محلياً
          if (chosenBooks[levelName]) {
            delete chosenBooks[levelName];
          }
          levels.splice(idx, 1);
          
          // حفظ في Firestore
          await appDataDocRef.set({ levels }, { merge: true });
          
          // إضافة العملية إلى الأرشيف
          await addToArchive('delete', 'level', `حذف المستوى الدراسي "${levelName}"`);
          
          // تحديث الواجهة
          renderLevels();
          renderLevelsSettingsModal();
          renderChosenBooksTables();
          showTemporaryAlert("تم حذف المستوى بنجاح وسيظهر التغيير لجميع المستخدمين", "success");
          
          // حفظ في التخزين المحلي
          localStorage.setItem('bookAppData_levels', JSON.stringify({ levels }));
          
          // حفظ الكتب المختارة المحدثة
          if (currentUser && userChosenBooksDocRef) {
            await userChosenBooksDocRef.set({ chosenBooks });
          }
        } catch (error) {
          console.error("خطأ في حذف المستوى:", error);
          showTemporaryAlert("حدث خطأ في حذف المستوى. يرجى المحاولة مرة أخرى", "error");
          
          // استعادة البيانات القديمة
          levels = oldLevels;
          chosenBooks = oldChosenBooks;
          renderLevelsSettingsModal();
        }
      }
    };

    function exportPDF() {
      // جمع كل الكتب المختارة في مصفوفة واحدة مع المستوى
      let allBooks = [];
      // Iterate through the main 'levels' array to ensure the correct order for export.
      levels.forEach(level => {
        const levelName = level.name;
        if (chosenBooks[levelName]) {
          const books = chosenBooks[levelName];
          // Sort books alphabetically within each level for consistency in the PDF.
          Object.keys(books).sort((a, b) => a.localeCompare(b, 'ar')).forEach(book => {
            allBooks.push({ level: levelName, book: book, count: books[book] });
          });
        }
      });

      // قسم الكتب إلى نصفين
      const mid = Math.ceil(allBooks.length / 2);
      const leftBooks = allBooks.slice(0, mid);
      const rightBooks = allBooks.slice(mid);

      // دالة توليد جدول HTML
      function booksTable(books) {
        let html = `<table class="books-table"><tr><th>المستوى</th><th>الكتاب</th><th>العدد</th></tr>`;
        let lastLevel = null;
        books.forEach(row => {
          if (lastLevel !== null && row.level !== lastLevel) {
            html += `<tr><td colspan="3" style="height:8px;border:none;"></td></tr>`;
          }
          html += `<tr>
            <td>${row.level}</td>
            <td>${row.book}</td>
            <td>${row.count}</td>
          </tr>`;
          lastLevel = row.level;
        });
        html += `</table>`;
        return html;
      }

      const win = window.open('', '', 'width=900,height=700');
      win.document.write(`
        <html>
          <head>
            <title>تصدير الكتب المختارة</title>
            <style>
              @media print {
                @page { size: A4; margin: 8mm; }
                body { font-family: 'Cairo', Tahoma, Arial, sans-serif; direction: rtl; background: #fff; font-size: 0.85em; }
                .tables-row { display: flex; flex-direction: row; gap: 12px; }
                .books-table { width: 48%; border-collapse: collapse; font-size: 0.85em; margin: 0; }
                th, td { border: 1px solid #e2e8f0; padding: 4px 6px; text-align: center; }
                th { background: #667eea; color: #fff; font-weight: 700; font-size: 1em; }
              }
            </style>
          </head>
          <body>
            <div class="tables-row">
              ${booksTable(leftBooks)}
              ${booksTable(rightBooks)}
            </div>
          </body>
        </html>
      `);
      win.document.close();
      win.print();
    }

    function sortBooks(books) {
      // دالة تحديد اللغة
      function getLang(text) {
        if (/[\u0600-\u06FF]/.test(text)) return 'ar'; // حروف عربية
        if (/^[a-zA-ZÀ-ÿ\s]+$/.test(text)) {
          if (/^[a-zA-Z\s]+$/.test(text)) return 'en'; // إنجليزية
          return 'fr'; // فرنسية
        }
        return 'other';
      }
      // ترتيب حسب اللغة ثم المادة (أبجدياً)
      return books.slice().sort((a, b) => {
        const langOrder = { ar: 0, fr: 1, en: 2, other: 3 };
        const langA = getLang(a);
        const langB = getLang(b);
        if (langOrder[langA] !== langOrder[langB]) {
          return langOrder[langA] - langOrder[langB];
        }
        // ترتيب حسب المادة (أبجدياً)
        return a.localeCompare(b, 'ar', { sensitivity: 'base' });
      });
    }

    window.onclick = function(e) {
      if (e.target === document.getElementById('booksModal')) closeBooksModal();
      if (e.target === document.getElementById('settingsModal')) closeSettingsModal();
      if (e.target === document.getElementById('notificationDetailModal')) closeNotificationDetail();
    };

    // New function to update connection status UI
    function updateConnectionStatus(status) {
      const statusIndicator = document.getElementById('connection-status');
      if (!statusIndicator) return;

      let text = '';
      let className = '';

      switch (status) {
        case 'connected':
          text = '☁️ متصل ';
          className = 'connected';
          break;
        case 'disconnected':
          text = '⚠️ غير متصل';
          className = 'disconnected';
          break;
        case 'connecting':
        default:
          text = '... جاري الاتصال';
          className = 'connecting';
          break;
      }
      statusIndicator.textContent = text;
      statusIndicator.className = status;
    }

    // Fallback function to load data from browser's local storage
    function loadFromLocalStorage() {
      try {
        // Try localStorage first
        let levelsDataString = localStorage.getItem('bookAppData_levels');
        let userKey = currentUser ? `bookAppData_${currentUser.uid}` : 'bookAppData_guest';
        let userDataString = localStorage.getItem(userKey);
        
        // If localStorage fails, try sessionStorage
        if (!levelsDataString || !userDataString) {
          try {
            levelsDataString = levelsDataString || sessionStorage.getItem('bookAppData_levels');
            userDataString = userDataString || sessionStorage.getItem(userKey);
          } catch (sessionError) {
            console.log('sessionStorage also blocked, using defaults');
          }
        }

        // Load levels data
        if (levelsDataString) {
          const levelsData = JSON.parse(levelsDataString);
          if (levelsData.levels) levels = levelsData.levels;
        }

        // Load user-specific chosen books
        if (userDataString) {
          const userData = JSON.parse(userDataString);
          if (userData.chosenBooks) chosenBooks = userData.chosenBooks;
        } else {
          chosenBooks = {};
        }
      } catch (e) {
        console.warn('Error loading from local storage (blocked by privacy settings):', e);
        console.log('Will rely on Firebase for data storage');
        chosenBooks = {};
      }
    }

    // Initialize the application and set up real-time synchronization
         async function initializeAndSyncData() {
       updateConnectionStatus('connecting'); // Set initial state
       
       // Wait for auth to be ready
       await new Promise(resolve => setTimeout(resolve, 1000));
       
       // Test Firebase connection first
       try {
         // First, check if Firestore exists
         const testDoc = await db.collection('test').doc('test').get();
         
         // Then try to access our app data
         const doc = await appDataDocRef.get();
         
         // If we get here, connection is successful
         setupRealtimeListener();
         
       } catch (error) {
         updateConnectionStatus('disconnected');
         
         if (error.code === 'permission-denied') {
           // Permission denied error - no alert shown
         } else if (error.code === 'not-found') {
           // Not found error - no alert shown
         } else {
           // Other connection errors - no alert shown
           console.error("Error connecting to Firebase:", error);
         }
         
         // Fallback to local storage
        loadFromLocalStorage();
      }
    }

    async function loadDataFromFirebase() {
      try {
        // Load levels data from Firebase
        const appDataDoc = await appDataDocRef.get();
        if (appDataDoc.exists) {
          const data = appDataDoc.data();
          if (data.levels && data.levels.length > 0) {
            levels = data.levels;
            localStorage.setItem('bookAppData_levels', JSON.stringify({ levels }));
          } else {
            // If no levels in Firebase, show error message
            throw new Error('لا توجد بيانات مستويات في قاعدة البيانات');
          }
        } else {
          throw new Error('لا توجد بيانات في قاعدة البيانات');
        }

        // Load user's chosen books if user is logged in
        if (currentUser && userChosenBooksDocRef) {
          const userDoc = await userChosenBooksDocRef.get();
          if (userDoc.exists) {
            const userData = userDoc.data();
            if (userData.chosenBooks) {
              chosenBooks = userData.chosenBooks;
              const userKey = `bookAppData_${currentUser.uid}`;
              localStorage.setItem(userKey, JSON.stringify({ chosenBooks }));
            }
          }
        }

        // Set up real-time listener after initial load
        setupRealtimeListener();
        
        // Render the UI
        renderLevels();
        renderChosenBooksTables();
        
      } catch (error) {
        console.error('Error loading data from Firebase:', error);
        throw error; // Re-throw to be caught by the calling function
      }
    }

    function setupRealtimeListener() {
      // Listen to shared app data (levels)
      appDataDocRef.onSnapshot(doc => {
        updateConnectionStatus('connected');

        if (doc.exists) {
          const data = doc.data();
          
          // Load levels if they exist
          if (data.levels && data.levels.length > 0) {
            levels = data.levels;
            localStorage.setItem('bookAppData_levels', JSON.stringify({ levels }));
          }
        }

        renderLevels();
        if (currentLevelIndex !== null && document.getElementById('booksModal').style.display === 'flex') {
          renderBooksList();
        }
      }, error => {
        // This block runs if the listener fails (e.g., offline, permissions error)
        updateConnectionStatus('disconnected'); // Update status to disconnected
        console.error("Error with Firebase real-time listener: ", error);
        
        // Fallback to local storage on error
        loadFromLocalStorage();
        renderLevels();
        renderChosenBooksTables();
      });
    }

    function setupUserChosenBooksListener() {
      if (!currentUser || !userChosenBooksDocRef) return;

      // Listen to user's chosen books
      const unsubscribe = userChosenBooksDocRef.onSnapshot(doc => {
        if (doc.exists) {
          const data = doc.data();
          if (data.chosenBooks) {
            chosenBooks = data.chosenBooks;
            // Cache user data locally
            const userKey = `bookAppData_${currentUser.uid}`;
            localStorage.setItem(userKey, JSON.stringify({ chosenBooks }));
          }
        } else {
          chosenBooks = {};
        }

        renderChosenBooksTables();
        if (currentLevelIndex !== null && document.getElementById('booksModal').style.display === 'flex') {
          renderBooksList();
        }
      }, error => {
        console.error("Error with user chosen books listener: ", error);
        loadFromLocalStorage();
        renderChosenBooksTables();
      });
    }

    // Authentication Functions

    function showRegisterModal() {
      closeAllModals();
      document.getElementById('registerModal').style.display = 'flex';
    }

    function closeRegisterModal() {
      document.getElementById('registerModal').style.display = 'none';
    }

    let userListener = null; // To hold the listener unsubscribe function

    // Function to clean up all listeners before logout
    function cleanupAllListeners() {
      try {
        // Clean up user listener
        if (userListener) {
          userListener();
          userListener = null;
        }
        
        // Clean up notifications listener
        if (notificationsListener) {
          notificationsListener();
          notificationsListener = null;
        }
        
        // Clean up admin messages listener
        if (adminMessagesListener) {
          adminMessagesListener();
          adminMessagesListener = null;
        }
        
        // Clean up messages listener
        if (messagesListener) {
          messagesListener();
          messagesListener = null;
        }
        
        // Clean up exchange listener
        if (window.currentExchangeListener) {
          window.currentExchangeListener();
          window.currentExchangeListener = null;
        }
        
        console.log('All listeners cleaned up successfully');
      } catch (error) {
        console.warn('Error during listener cleanup:', error);
      }
    }

    auth.onAuthStateChanged(user => {
      // If a listener from a previous user is active, unsubscribe from it
      if (userListener) {
        userListener();
        userListener = null;
      }

      if (user) {
        // Set up a real-time listener for the current user's document
        userListener = db.collection('users').doc(user.uid).onSnapshot(doc => {
          if (!doc.exists) {
            // This can happen if the user document is deleted.
            auth.signOut();
            return;
          }

          const newUserData = doc.data();

          // Check for account deactivation first.
          // This is critical to prevent a deactivated user from continuing.
          if (currentUser && currentUser.isActive && !newUserData.isActive) {
            showTemporaryAlert("تم تعطيل حسابك من قبل المسؤول.", "error");
            auth.signOut(); // This will trigger onAuthStateChanged, cleaning up the UI.
            return; // Stop processing further changes for the now-logged-out user.
          }

          const hadEditPermission = currentUser ? (currentUser.canEditContent || false) : null;
          const hasEditPermissionNow = newUserData.canEditContent || false;

          // Update the global currentUser object
          currentUser = { uid: user.uid, email: user.email, ...newUserData };
          isAdmin = currentUser.isAdmin || false;

          // If this is the first time we're loading the user data in this session
          if (hadEditPermission === null) {
            const authContainer = document.getElementById('authContainer');
            const mainContent = document.getElementById('mainContent');
            const logoutBtn = document.getElementById('logoutBtn');
            
            if (authContainer) authContainer.style.display = 'none';
            if (mainContent) mainContent.style.display = 'block';
            if (logoutBtn) logoutBtn.style.display = 'block';
            const userEmailElement = document.getElementById('userEmail');
            if (userEmailElement) {
              userEmailElement.textContent = user.email;
            }
            loadInitialData();
          } else if (hadEditPermission !== hasEditPermissionNow) {
            // If only the edit permission changed
            showTemporaryAlert("تم تحديث صلاحياتك.", "info");
            renderLevels();
            if (currentLevelIndex !== null) {
              showLevel(currentLevelIndex);
            }
            renderChosenBooksTables();
          }

          // Always ensure admin panel visibility is correct
          const adminPanel = document.getElementById('adminPanel');
          const adminPanelBtn = document.getElementById('adminPanelBtn');
          
          // التحقق من وجود زر لوحة الإدارة قبل محاولة الوصول إليه
          if (adminPanelBtn) {
            adminPanelBtn.style.display = isAdmin ? 'block' : 'none';
          }
          
          if (adminPanel && !isAdmin && adminPanel.style.display === 'block') {
            adminPanel.style.display = 'none';
          }
        }, error => {
          console.error("Error listening to user document:", error);
        });
      } else {
        // User is signed out
        currentUser = null;
        isAdmin = false;
        const authContainer = document.getElementById('authContainer');
        const mainContent = document.getElementById('mainContent');
        const logoutBtn = document.getElementById('logoutBtn');
        
        if (authContainer) authContainer.style.display = 'block';
        if (mainContent) mainContent.style.display = 'none';
        if (logoutBtn) logoutBtn.style.display = 'none';
        const adminPanelBtn = document.getElementById('adminPanelBtn');
        if (adminPanelBtn) {
          adminPanelBtn.style.display = 'none';
        }
        const adminPanel = document.getElementById('adminPanel');
        if (adminPanel) {
          adminPanel.style.display = 'none';
        }
        chosenBooks = {};
        renderLevels();
        renderChosenBooksTables();
      }
    });

    function showAdminModal() {
      closeAllModals();
      document.getElementById('adminModal').style.display = 'flex';
      loadUsersForAdmin();
    }

    function closeAdminModal() {
      document.getElementById('adminModal').style.display = 'none';
    }

    function closeAllModals() {
      document.getElementById('registerModal').style.display = 'none';
      document.getElementById('forgotPasswordModal').style.display = 'none';
      document.getElementById('adminModal').style.display = 'none';
      document.getElementById('booksModal').style.display = 'none';
      document.getElementById('settingsModal').style.display = 'none';
    }

    // Main Login Form Handler
    document.getElementById('mainLoginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('mainLoginEmail').value;
      const password = document.getElementById('mainLoginPassword').value;

      try {
        const userCredential = await auth.signInWithEmailAndPassword(email, password);
        const user = userCredential.user;
        
        // Check if user is activated
        const userDoc = await usersCollection.doc(user.uid).get();
        if (userDoc.exists) {
          const userData = userDoc.data();
          if (!userData.isActive) {
            alert('حسابك غير مُفعل بعد. يرجى انتظار موافقة المدير.');
            await auth.signOut();
            return;
          }
        }
        
        alert('تم تسجيل الدخول بنجاح!');
      } catch (error) {
        console.error('Login error:', error);
        let errorMessage = 'خطأ في تسجيل الدخول: ';
        
        if (error.code === 'auth/invalid-login-credentials') {
          errorMessage += 'بيانات تسجيل الدخول غير صحيحة. تأكد من البريد الإلكتروني وكلمة المرور.';
        } else if (error.code === 'auth/user-not-found') {
          errorMessage += 'المستخدم غير موجود. تأكد من البريد الإلكتروني أو قم بإنشاء حساب جديد.';
        } else if (error.code === 'auth/wrong-password') {
          errorMessage += 'كلمة المرور غير صحيحة.';
        } else if (error.code === 'auth/too-many-requests') {
          errorMessage += 'تم تجاوز عدد المحاولات المسموح. حاول مرة أخرى لاحقاً.';
        } else if (error.code === 'auth/operation-not-allowed') {
          errorMessage = 'Authentication غير مُفعل. يجب تفعيل Email/Password في Firebase Console أولاً.';
        } else {
          errorMessage += error.message;
        }
        
        alert(errorMessage);
      }
    });

    // Register Form Handler
    document.getElementById('registerForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('registerName').value;
      const email = document.getElementById('registerEmail').value;
      const phone = document.getElementById('registerPhone').value;
      const password = document.getElementById('registerPassword').value;

      try {
        const userCredential = await auth.createUserWithEmailAndPassword(email, password);
        const user = userCredential.user;
        
        // Update profile
        await user.updateProfile({
          displayName: name
        });

        // Save user data to Firestore
        await usersCollection.doc(user.uid).set({
          name: name,
          email: email,
          phone: phone,
          isAdmin: false,
          isActive: false, // New users are inactive by default
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        closeRegisterModal();
        alert('تم إنشاء الحساب بنجاح! يرجى انتظار موافقة المدير لتفعيل حسابك.');
        
        // Sign out the user since they're not activated yet
        await auth.signOut();
      } catch (error) {
        console.error('Registration error:', error);
        alert('خطأ في إنشاء الحساب: ' + error.message);
      }
    });

    // Forgot Password Form Handler
    document.getElementById('forgotPasswordForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('forgotEmail').value;

      try {
        await auth.sendPasswordResetEmail(email);
        closeForgotPasswordModal();
        alert('تم إرسال رابط استعادة كلمة المرور إلى بريدك الإلكتروني.');
      } catch (error) {
        console.error('Password reset error:', error);
        alert('خطأ في إرسال رابط الاستعادة: ' + error.message);
      }
    });

        // Auth State Observer - handles user authentication state changes
    auth.onAuthStateChanged(async (user) => {
      if (user) {
        // User is signed in
       // console.log('✅ User authenticated:', user.email);
        currentUser = user;
        
        
        userChosenBooksDocRef = db.collection('userChosenBooks').doc(user.uid);
        
        // Check user data and admin status
        try {
          const userDoc = await usersCollection.doc(user.uid).get();
          if (userDoc.exists) {
            const userData = userDoc.data();
            isAdmin = userData.isAdmin || false;
            currentUser.canEditContent = userData.canEditContent || false;

            // **Crucial Check**: Is the user active?
            if (!userData.isActive) {
              console.warn('User is not active. Signing out.');
              showTemporaryAlert('حسابك غير مُفعل. يرجى انتظار موافقة المدير.', 'error');
              await auth.signOut(); // This will re-trigger onAuthStateChanged with user=null
              return; // Stop further execution for this user
            }
            
            if (!userData.isActive) {
              // User is not activated
              document.getElementById('login-page').style.display = 'block';
              document.getElementById('main-app').style.display = 'none';
              
              alert('حسابك غير مُفعل. يرجى انتظار موافقة المدير.');
              try {
                await auth.signOut();
              } catch (signOutError) {
                console.log('Sign out error (this is normal):', signOutError);
                // Force reload if sign out fails
                window.location.reload();
              }
              return;
            }
          } else {
            // User document doesn't exist in Firestore
            isAdmin = false;
            
            // Try to create basic user document
            try {
              await usersCollection.doc(user.uid).set({
                name: user.displayName || user.email,
                email: user.email,
                isAdmin: false,
                isActive: true, // Auto-activate for now since admin system needs setup
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
              });
              // Basic user document created
            } catch (createError) {
              // Could not create user document, but continuing anyway
            }
          }
        } catch (error) {
          console.error('Error accessing Firestore:', error);
          // If we can't access Firestore, treat as regular user
          isAdmin = false;
        }
        
        // Load data from Firebase first, then set up listeners
        try {
          await loadDataFromFirebase();
          setupUserChosenBooksListener();
          updateLoadingStatus('تم التحميل بنجاح!');
        } catch (error) {
          console.error('Error loading data from Firebase:', error);
          updateLoadingStatus('فشل في تحميل البيانات');
          showTemporaryAlert('فشل في تحميل البيانات من قاعدة البيانات. المرجو إعادة تحميل الصفحة لجلب البيانات.', 'error');
          // Fallback to local storage
          loadFromLocalStorage();
          setupUserChosenBooksListener();
        }
        
        // Hide loading screen and show main app
        setTimeout(() => {
          const loadingScreen = document.getElementById('loading-screen');
          const loginPage = document.getElementById('login-page');
          const mainApp = document.getElementById('main-app');

          if (loadingScreen) loadingScreen.style.display = 'none';
          if (loginPage) loginPage.style.display = 'none';
          if (mainApp) mainApp.style.display = 'block';

          const welcomeText = document.getElementById('welcome-text');
          if (welcomeText) {
            welcomeText.textContent = `مرحباً ${user.displayName || user.email}`;
          }
          
          // حساب إحصائيات العروض والطلبات أولاً ثم تحميل الإعلانات
          countExchangeStats().then(() => {
            // Initialize exchange listings
            loadExchangeListings('my');
          });
          
          // التحقق من العروض والطلبات المنتهية
          checkExpiredExchanges();
          
          // إعداد نظام الإشعارات
          setupNotificationsListener();
          
          // فحص العروض والطلبات التي ستنتهي قريباً
          checkExpiringExchanges();
          
          // Setup admin messages listener with delay
          setTimeout(() => {
            setupAdminMessagesListener();
          }, 5000);
          
          // Setup messages listener for messages dropdown
          setTimeout(() => {
            setupMessagesListener();
          }, 6000);
          
          // Check for pending admin messages with delay
          if (!isAdmin) {
            setTimeout(() => {
              checkPendingAdminMessages();
            }, 8000);
          }
        }, 500);
        
        // Update admin UI elements
        updateAdminUI();
        
      } else {
        // User is signed out
        currentUser = null;
        isAdmin = false;
        userChosenBooksDocRef = null;
        chosenBooks = {}; // Clear chosen books when signed out

        // Hide loading screen and show login page
        const loadingScreen = document.getElementById('loading-screen');
        const loginPage = document.getElementById('login-page');
        const mainApp = document.getElementById('main-app');

        if (loadingScreen) loadingScreen.style.display = 'none';
        if (loginPage) loginPage.style.display = 'block';
        if (mainApp) mainApp.style.display = 'none';

        updateLoadingStatus('جاري تسجيل الخروج...');

        // Update admin UI elements (hide admin buttons)
        updateAdminUI();
        renderChosenBooksTables(); // Clear the chosen books display
      }
    });


    // Admin Functions
    async function loadUsersForAdmin() {
      const content = document.getElementById('adminContent');
      content.innerHTML = '<p>جاري تحميل المستخدمين...</p>';

      try {
        const usersSnapshot = await usersCollection.orderBy('createdAt', 'desc').get();
        let html = `
          <table class="user-management-table">
            <thead>
              <tr>
                <th>الاسم</th>
                <th>البريد الإلكتروني</th>
                <th>رقم الهاتف</th>
                <th>الحالة</th>
                <th>الدور</th>
                <th>تفعيل</th>
                <th>صلاحية التحرير</th>
                <th>تعيين مدير</th>
              </tr>
            </thead>
            <tbody>
        `;

        usersSnapshot.forEach(doc => {
          const userData = doc.data();
          const userId = doc.id;
          const isCurrentUser = userId === currentUser.uid;
          const userIsAdmin = userData.isAdmin || false;
          const canEdit = userData.canEditContent || false;
          const phone = userData.phone || 'غير متوفر';

          let roleText = 'مستخدم';
          if (userIsAdmin) {
            roleText = 'مدير';
          } else if (canEdit) {
            roleText = 'محرر محتوى';
          }
          
          html += `
            <tr>
              <td>${userData.name || 'غير متوفر'}</td>
              <td>${userData.email}</td>
              <td>${userData.phone || 'غير متوفر'}</td>
              <td class="${userData.isActive ? 'status-active' : 'status-pending'}">
                ${userData.isActive ? 'نشط' : 'في الانتظار'}
              </td>
              <td>${roleText}</td>
              <td>
                ${!isCurrentUser && !userIsAdmin ? `
                  <label class="toggle-switch">
                    <input type="checkbox" ${userData.isActive ? 'checked' : ''} onchange="toggleUserActivation('${userId}', this.checked)">
                    <span class="slider"></span>
                  </label>
                ` : ''}
              </td>
              <td>
                ${!isCurrentUser && !userIsAdmin ? `
                  <label class="toggle-switch">
                    <input type="checkbox" ${canEdit ? 'checked' : ''} onchange="toggleContentEditorRole('${userId}', this.checked)">
                    <span class="slider"></span>
                  </label>
                ` : (isCurrentUser ? '<i>(حسابك الحالي)</i>' : '<i>(لا يمكن تعديل مدير)</i>')}
              </td>
              <td>
                ${!isCurrentUser ? (
                  userIsAdmin ? 
                  `<button class="admin-action-btn revoke-admin-btn" onclick="revokeUserAdmin('${userId}', '${userData.name || userData.email}')">
                    إلغاء المدير
                  </button>` : 
                  `<button class="admin-action-btn make-admin-btn" onclick="makeUserAdmin('${userId}', '${userData.name || userData.email}')">
                    تعيين مدير
                  </button>`
                ) : '<i>(حسابك الحالي)</i>'}
              </td>
            </tr>
          `;
        });
        
        html += `</tbody></table>`;
        content.innerHTML = html;
      } catch (error) {
        console.error('Error loading users:', error);
        content.innerHTML = `<p style="color: red; text-align: center;">حدث خطأ أثناء تحميل المستخدمين.</p>`;
      }
    }

    // Activate User Function
    window.activateUser = async function(userId) {
      if (!isAdmin) return;
      
      try {
        await usersCollection.doc(userId).update({
          isActive: true
        });
        alert('تم تفعيل المستخدم بنجاح!');
        loadUsersForAdmin(); // Refresh the list
      } catch (error) {
        console.error('Error activating user:', error);
        alert('خطأ في تفعيل المستخدم');
      }
    };

    // Delete User Function
    window.deleteUser = async function(userId) {
      if (!isAdmin) return;
      
      if (confirm('هل أنت متأكد من حذف هذا المستخدم؟ هذا الإجراء لا يمكن التراجع عنه.')) {
        try {
          await usersCollection.doc(userId).delete();
          alert('تم حذف المستخدم بنجاح!');
          loadUsersForAdmin(); // Refresh the list
        } catch (error) {
          console.error('Error deleting user:', error);
          alert('خطأ في حذف المستخدم');
        }
      }
    };

    // Make User Admin Function
    window.makeUserAdmin = async function(userId, userName) {
      if (!isAdmin) {
        showTemporaryAlert('ليس لديك الصلاحية لتنفيذ هذا الإجراء', 'error');
        return;
      }
      
      if (userId === currentUser.uid) {
        showTemporaryAlert('لا يمكنك تغيير صلاحياتك الخاصة', 'error');
        return;
      }
      
      // تأكيد مزدوج لأهمية هذا الإجراء
      const confirmMessage = `هل أنت متأكد من جعل "${userName}" مديراً؟\n\nسيحصل هذا المستخدم على جميع صلاحيات المدير بما في ذلك:\n- إدارة المستخدمين\n- تعديل المستويات والكتب\n- إرسال الرسائل الإدارية\n- الوصول إلى الأرشيف\n- جعل مستخدمين آخرين مدراء\n\nهذا الإجراء مهم جداً!`;
      
      if (!confirm(confirmMessage)) {
        return;
      }
      
      if (!confirm('تأكيد أخير: هل أنت متأكد 100% من جعل هذا المستخدم مديراً؟')) {
        return;
      }
      
      try {
        // تحديث بيانات المستخدم لجعله مديراً
        await usersCollection.doc(userId).update({
          isAdmin: true,
          canEditContent: true, // المدراء لديهم صلاحية التحرير تلقائياً
          promotedToAdminAt: firebase.firestore.FieldValue.serverTimestamp(),
          promotedByAdmin: currentUser.uid,
          promotedByAdminName: currentUser.name || currentUser.displayName || currentUser.email
        });
        
        // إضافة العملية إلى الأرشيف
        await addToArchive('edit', 'user', `تم ترقية المستخدم "${userName}" إلى مدير`);
        
        showTemporaryAlert(`تم جعل "${userName}" مديراً بنجاح! سيحصل على جميع صلاحيات المدير عند تسجيل الدخول التالي.`, 'success');
        
        // إعادة تحميل قائمة المستخدمين
        loadUsersForAdmin();
        
      } catch (error) {
        console.error('Error making user admin:', error);
        showTemporaryAlert('حدث خطأ في جعل المستخدم مديراً', 'error');
      }
    };

    // Revoke User Admin Function
    window.revokeUserAdmin = async function(userId, userName) {
      if (!isAdmin) {
        showTemporaryAlert('ليس لديك الصلاحية لتنفيذ هذا الإجراء', 'error');
        return;
      }
      
      if (userId === currentUser.uid) {
        showTemporaryAlert('لا يمكنك إلغاء صلاحياتك الخاصة', 'error');
        return;
      }
      
      const confirmMessage = `هل أنت متأكد من إلغاء صلاحيات المدير للمستخدم "${userName}"؟\n\nسيتم تحويل هذا المستخدم إلى مستخدم عادي وسيفقد جميع صلاحيات المدير.\n\nهذا الإجراء مهم جداً!`;
      
      if (!confirm(confirmMessage)) {
        return;
      }
      
      try {
        // تحديث بيانات المستخدم لإلغاء صلاحيات المدير
        await usersCollection.doc(userId).update({
          isAdmin: false,
          revokedAdminAt: firebase.firestore.FieldValue.serverTimestamp(),
          revokedByAdmin: currentUser.uid,
          revokedByAdminName: currentUser.name || currentUser.displayName || currentUser.email
        });
        
        // إضافة العملية إلى الأرشيف
        await addToArchive('edit', 'user', `تم إلغاء صلاحيات المدير للمستخدم "${userName}"`);
        
        showTemporaryAlert(`تم إلغاء صلاحيات المدير للمستخدم "${userName}" بنجاح.`, 'success');
        
        // إعادة تحميل قائمة المستخدمين
        loadUsersForAdmin();
        
      } catch (error) {
        console.error('Error revoking user admin:', error);
        showTemporaryAlert('حدث خطأ في إلغاء صلاحيات المدير', 'error');
      }
    };

         // Function to update admin-only UI elements
     function updateAdminUI() {
       // Check if user has edit permissions
       const hasEditPermission = isAdmin || (currentUser && currentUser.canEditContent);
       
       // Show/hide admin panel button (admin only)
       const adminPanelBtn = document.getElementById('adminPanelBtn');
       if (adminPanelBtn) {
         adminPanelBtn.style.display = isAdmin ? 'inline-block' : 'none';
       }
       
       // Show/hide admin message button (admin only)
       const adminMessageBtn = document.getElementById('adminMessageBtn');
       if (adminMessageBtn) {
         adminMessageBtn.style.display = isAdmin ? 'inline-block' : 'none';
       }

       // Hide contact admin button for admin users (since admin is the administration)
       const contactAdminBtn = document.getElementById('contactAdminBtn');
       if (contactAdminBtn) {
         contactAdminBtn.style.display = isAdmin ? 'none' : 'inline-block';
       }
 
       // Show/hide settings button (admin or editor)
       const settingsBtn = document.getElementById('settingsBtn');
       if (settingsBtn) {
         settingsBtn.style.display = hasEditPermission ? 'block' : 'none';
       }
 
       // Show/hide "Add new book" button (admin or editor)
       const addBookBtn = document.getElementById('addBookBtn');
       if (addBookBtn) {
         addBookBtn.style.display = hasEditPermission ? 'block' : 'none';
       }
 
       // Show/hide "Add new level" button in settings (admin or editor)
       const addLevelSettingsBtn = document.getElementById('addLevelSettingsBtn');
       if (addLevelSettingsBtn) {
         addLevelSettingsBtn.style.display = hasEditPermission ? 'block' : 'none';
       }
       
       // Re-render lists to show/hide edit buttons inside them
       const booksModal = document.getElementById('booksModal');
       if (booksModal && booksModal.style.display === 'flex') {
         renderBooksList();
       }
       
       const settingsModal = document.getElementById('settingsModal');
       if (settingsModal && settingsModal.style.display === 'flex') {
         renderLevelsSettingsModal();
       }
       
       // Show edit permission status if user has it
       if (currentUser && !isAdmin && currentUser.canEditContent) {
         showTemporaryAlert('لديك صلاحية تحرير المحتوى ✍️', 'success');
       }
     }

    // Close modals when clicking outside
    window.onclick = function(e) {
      if (e.target === document.getElementById('booksModal')) closeBooksModal();
      if (e.target === document.getElementById('registerModal')) closeRegisterModal();
      if (e.target === document.getElementById('forgotPasswordModal')) closeForgotPasswordModal();
      if (e.target === document.getElementById('adminModal')) closeAdminModal();
      if (e.target === document.getElementById('exchangeModal')) closeExchangeModal();
      if (e.target === document.getElementById('accountSettingsModal')) closeAccountSettingsModal();
    }
    
    // مراقبة حالة الاتصال بقاعدة البيانات
    function setupConnectionMonitoring() {
      try {
        // Simple connection check without enableNetwork to avoid SDK issues
        const testDoc = db.collection('_test').doc('connection');
        testDoc.get()
          .then(() => {
            updateConnectionStatus(true);
          })
          .catch(() => {
            updateConnectionStatus(false);
          });
      } catch (error) {
        updateConnectionStatus(false);
      }
      
      // إضافة مستمع للاتصال بالإنترنت
      window.addEventListener('online', () => {
        updateConnectionStatus(true);
      });
      
      window.addEventListener('offline', () => {
        updateConnectionStatus(false);
      });
    }
    
    // استدعاء وظيفة مراقبة الاتصال عند بدء التطبيق
    setTimeout(setupConnectionMonitoring, 2000);

    // Notifications System Functions
    
    // Create notification in database
    async function createNotification(type, title, message, targetUserId = null, relatedData = null) {
      try {
        const notificationData = {
          type: type, // 'expiry_warning', 'new_exchange', 'system'
          title: title,
          message: message,
          userId: targetUserId, // Changed from targetUserId to userId for consistency
          createdBy: currentUser ? currentUser.uid : 'system',
          createdByName: currentUser ? (currentUser.name || currentUser.displayName || currentUser.email) : 'النظام',
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          read: false, // Changed from isRead to read for consistency
          relatedData: relatedData || null
        };
        
        await notificationsCollection.add(notificationData);
      } catch (error) {
        console.error('Error creating notification:', error);
      }
    }
    
    // Format notification time
    function formatNotificationTime(notification) {
      let timeText = 'الآن';
      if (notification.createdAt) {
        const notificationTime = notification.createdAt.toDate();
        const now = new Date();
        const diffMs = now - notificationTime;
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);
        
        if (diffMins < 1) {
          timeText = 'الآن';
        } else if (diffMins < 60) {
          timeText = `منذ ${diffMins} دقيقة`;
        } else if (diffHours < 24) {
          timeText = `منذ ${diffHours} ساعة`;
        } else {
          timeText = `منذ ${diffDays} يوم`;
        }
      }
      return timeText;
    }
    
    // Setup notifications listener with enhanced error handling
    function setupNotificationsListener() {
      if (!currentUser) return;
      
      // Clean up existing listener
      if (notificationsListener) {
        try {
          notificationsListener();
        } catch (e) {
          console.warn('Error cleaning up notifications listener:', e);
        }
        notificationsListener = null;
      }
      
      // Add delay and retry mechanism
      setTimeout(() => {
        // Double check currentUser is still available after timeout
        if (!currentUser) {
          console.log('❌ setupNotificationsListener: No current user after timeout');
          return;
        }
        
        try {
          notificationsListener = notificationsCollection
            .where('userId', '==', currentUser.uid)
            .limit(50)
            .onSnapshot((snapshot) => {
              try {
                notifications = [];
                snapshot.forEach(doc => {
                  const data = doc.data();
                  if (data) {
                    notifications.push({ id: doc.id, ...data });
                  }
                });
                
                // Sort locally to avoid compound index issues
                notifications.sort((a, b) => {
                  const timeA = a.createdAt ? a.createdAt.toDate() : new Date(0);
                  const timeB = b.createdAt ? b.createdAt.toDate() : new Date(0);
                  return timeB - timeA;
                });
                
                // Count unread notifications
                unreadNotifications = notifications.filter(n => !n.read).length;
                
                // Update UI
                updateNotificationsBadge();
                
                // If dropdown is open, refresh the list
                if (isNotificationsDropdownOpen) {
                  renderNotificationsList();
                }
              } catch (snapshotError) {
                console.error('Error processing notifications snapshot:', snapshotError);
              }
            }, (error) => {
              console.error('Notifications listener error:', error);
              // Don't retry automatically to avoid infinite loops
            });
        } catch (error) {
          console.error('Error setting up notifications listener:', error);
        }
      }, 3000); // 3 second delay
    }
    
    // Update notifications badge
    function updateNotificationsBadge() {
      const badge = document.getElementById('notificationsBadge');
      if (!badge) return;
      
      if (unreadNotifications > 0) {
        badge.textContent = unreadNotifications > 99 ? '99+' : unreadNotifications;
        badge.style.display = 'flex';
      } else {
        badge.style.display = 'none';
      }
    }
    
    // Toggle notifications dropdown
    function toggleNotifications() {
      const dropdown = document.getElementById('notificationsDropdown');
      if (!dropdown) return;
      
      isNotificationsDropdownOpen = !isNotificationsDropdownOpen;
      
      if (isNotificationsDropdownOpen) {
        dropdown.classList.add('show');
        notificationsLoaded = 0;
        renderNotificationsList();
        
        // Mark all notifications as read immediately when opening notifications
        markAllNotificationsAsRead();
        
        // Reset badge count immediately when opening notifications
        unreadNotifications = 0;
        updateNotificationsBadge();
      } else {
        dropdown.classList.remove('show');
      }
    }
    
    // Render notifications list
    function renderNotificationsList() {
      const listElement = document.getElementById('notificationsList');
      const loadMoreElement = document.getElementById('notificationsLoadMore');
      
      if (!listElement) return;
      
      if (notifications.length === 0) {
        listElement.innerHTML = '<div class="notifications-empty">لا توجد إشعارات</div>';
        loadMoreElement.style.display = 'none';
        return;
      }
      
      const endIndex = Math.min(notificationsLoaded + notificationsPerPage, notifications.length);
      const visibleNotifications = notifications.slice(0, endIndex);
      
      listElement.innerHTML = '';
      
      visibleNotifications.forEach(notification => {
        const item = document.createElement('div');
        item.className = `notification-item ${!notification.isRead ? 'unread' : ''}`;
        
        const timeText = formatNotificationTime(notification);
        
        // Determine notification type badge
        let typeBadge = '';
        if (notification.type === 'expiry_warning') {
          typeBadge = '<span class="notification-type-badge notification-type-expiry">تحذير انتهاء</span>';
        } else if (notification.type === 'new_exchange') {
          typeBadge = '<span class="notification-type-badge notification-type-new-exchange">جديد</span>';
        } else {
          typeBadge = '<span class="notification-type-badge notification-type-system">نظام</span>';
        }
        
        item.innerHTML = `
          ${typeBadge}
          <div class="notification-content">
            <div class="notification-title">${notification.title}</div>
            <div class="notification-message">${notification.message}</div>
            <div class="notification-time">${timeText}</div>
          </div>
        `;
        
        // Add click handler to show details
        item.onclick = () => showNotificationDetail(notification);
        
        listElement.appendChild(item);
      });
      
      notificationsLoaded = endIndex;
      
      // Show/hide load more button
      if (notificationsLoaded < notifications.length) {
        loadMoreElement.style.display = 'block';
      } else {
        loadMoreElement.style.display = 'none';
      }
    }
    
    // Load more notifications
    function loadMoreNotifications() {
      renderNotificationsList();
    }
    
    // Mark all notifications as read
    async function markAllNotificationsAsRead() {
      if (!currentUser) return;
      
      try {
        const batch = db.batch();
        
        notifications.forEach(notification => {
          if (!notification.read) { 
            const notificationRef = notificationsCollection.doc(notification.id);
            batch.update(notificationRef, { read: true });
          }
        });
        
        await batch.commit();
        
        // Update local notifications array
        notifications.forEach(notification => {
          notification.read = true;
        });
        
      } catch (error) {
        console.error('Error marking notifications as read:', error);
      }
    }
    
    // Clear all notifications
    async function clearAllNotifications() {
      if (!currentUser) return;
      
      if (confirm('هل أنت متأكد من حذف جميع الإشعارات؟')) {
        try {
          const batch = db.batch();
          
          notifications.forEach(notification => {
            const notificationRef = notificationsCollection.doc(notification.id);
            batch.delete(notificationRef);
          });
          
          await batch.commit();
          showTemporaryAlert('تم حذف جميع الإشعارات', 'success');
        } catch (error) {
          console.error('Error clearing notifications:', error);
          showTemporaryAlert('حدث خطأ في حذف الإشعارات', 'error');
        }
      }
    }
    
    // Show notification detail modal
    async function showNotificationDetail(notification) {
      // التحقق من وجود الإعلان إذا كان الإشعار مرتبط بإعلان
      if (notification.type === 'new_exchange' && notification.relatedData && notification.relatedData.exchangeId) {
        try {
          const exchangeDoc = await exchangeCollection.doc(notification.relatedData.exchangeId).get();
          if (!exchangeDoc.exists) {
            // الإعلان محذوف - إظهار رسالة تنبيه
            showTemporaryAlert('تم حذف هذا الإعلان من قبل صاحبه', 'error');
            
            // حذف الإشعار من قاعدة البيانات
            await notificationsCollection.doc(notification.id).delete();
            
            // إعادة تحميل الإشعارات
            if (isNotificationsDropdownOpen) {
              renderNotificationsList();
            }
            
            return;
          }
        } catch (error) {
          console.error('Error checking exchange existence:', error);
          showTemporaryAlert('حدث خطأ في التحقق من الإعلان', 'error');
          return;
        }
      }
      
      
      const modal = document.getElementById('notificationDetailModal');
      const title = document.getElementById('notificationDetailTitle');
      const message = document.getElementById('notificationDetailMessage');
      const info = document.getElementById('notificationDetailInfo');
      
      if (!modal || !title || !message || !info) return;
      
      title.textContent = notification.title;
      message.textContent = notification.message;
      
      // Show additional info if available
      if (notification.relatedData) {
        info.style.display = 'block';
        let infoHTML = '';
        
        if (notification.type === 'new_exchange') {
          const data = notification.relatedData;
          infoHTML = `
            <div class="notification-detail-info-item">
              <span class="notification-detail-info-label">اسم الكتاب:</span>
              <span class="notification-detail-info-value">${data.bookName || 'غير محدد'}</span>
            </div>
            <div class="notification-detail-info-item">
              <span class="notification-detail-info-label">المستوى:</span>
              <span class="notification-detail-info-value">${data.bookLevel || 'غير محدد'}</span>
            </div>
            <div class="notification-detail-info-item">
              <span class="notification-detail-info-label">العدد:</span>
              <span class="notification-detail-info-value">${data.count || 'غير محدد'}</span>
            </div>
            <div class="notification-detail-info-item">
              <span class="notification-detail-info-label">النوع:</span>
              <span class="notification-detail-info-value">${data.type === 'offer' ? 'عرض' : 'طلب'}</span>
            </div>
            <div class="notification-detail-info-item">
              <span class="notification-detail-info-label">المستخدم:</span>
              <span class="notification-detail-info-value">${data.userName || 'غير محدد'}</span>
            </div>
            <div class="notification-detail-info-item">
              <span class="notification-detail-info-label">البريد الإلكتروني:</span>
              <span class="notification-detail-info-value">${data.userEmail || 'غير محدد'}</span>
            </div>
            <div class="notification-detail-info-item">
              <span class="notification-detail-info-label">رقم الهاتف:</span>
              <span class="notification-detail-info-value">${data.userPhone || 'غير محدد'}</span>
            </div>
          `;
          
          // إضافة زر عرض صورة الكتاب إذا كانت متوفرة - أولاً من بيانات الإشعار، ثم من المستوى
          let bookImageUrl = data.bookImageUrl || null;
          
          // إذا لم توجد صورة في بيانات الإشعار، ابحث في بيانات المستوى
          if (!bookImageUrl && data.bookLevel && data.bookName) {
            const level = levels.find(l => l.name === data.bookLevel);
            if (level && level.bookImages && level.bookImages[data.bookName]) {
              bookImageUrl = level.bookImages[data.bookName];
            }
          }
          
          if (bookImageUrl) {
            infoHTML += `
              <div class="notification-detail-info-item" style="margin-top: 15px; text-align: center;">
                <button class="view-notification-image-btn" onclick="showImageModal('${bookImageUrl}', '${data.bookName}')" title="عرض صورة الكتاب">
                  👁️ عرض صورة الكتاب
                </button>
              </div>
            `;
          }
        }
        
        info.innerHTML = infoHTML;
      } else {
        info.style.display = 'none';
      }
      
      modal.style.display = 'flex';
      
      // Close dropdown
      toggleNotifications();
    }
    
    // Close notification detail modal
    function closeNotificationDetail() {
      const modal = document.getElementById('notificationDetailModal');
      if (modal) {
        modal.style.display = 'none';
      }
    }
    
    // Check for expiring exchanges and create notifications
    async function checkExpiringExchanges() {
      if (!currentUser) return;
      
      try {
        const now = new Date();
        const oneWeekLater = new Date();
        oneWeekLater.setDate(now.getDate() + 7);
        
        // Get exchanges for current user first, then filter by date to avoid compound index
        const snapshot = await exchangeCollection
          .where('userId', '==', currentUser.uid)
          .get();
        
        const expiringExchanges = [];
        snapshot.forEach(doc => {
          const exchange = doc.data();
          if (exchange.expiryDate) {
            const expiryDate = exchange.expiryDate.toDate();
            if (expiryDate > now && expiryDate <= oneWeekLater) {
              expiringExchanges.push({ id: doc.id, data: exchange });
            }
          }
        });
        
        // Process expiring exchanges
        for (const item of expiringExchanges) {
          const exchange = item.data;
          const expiryDate = exchange.expiryDate.toDate();
          const daysLeft = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));
          
          const typeText = exchange.type === 'offer' ? 'عرض' : 'طلب';
          const title = `تحذير: انتهاء صلاحية ${typeText}`;
          const message = `${typeText} الكتاب "${exchange.bookName}" سينتهي بعد ${daysLeft} أيام`;
          
          // Check if notification already exists for this exchange
          const existingNotification = await notificationsCollection
            .where('type', '==', 'expiry_warning')
            .where('targetUserId', '==', currentUser.uid)
            .get();
          
          let notificationExists = false;
          existingNotification.forEach(doc => {
            const data = doc.data();
            if (data.relatedData && data.relatedData.exchangeId === item.id) {
              notificationExists = true;
            }
          });
          
          if (!notificationExists) {
            await createNotification('expiry_warning', title, message, currentUser.uid, {
              exchangeId: item.id,
              bookName: exchange.bookName,
              type: exchange.type,
              daysLeft: daysLeft
            });
          }
        }
      } catch (error) {
        console.error('Error checking expiring exchanges:', error);
      }
    }
    
    // Create notification for new exchange
    async function notifyNewExchange(exchangeData) {
      try {
        const typeText = exchangeData.type === 'offer' ? 'عرض' : 'طلب';
        const title = `${typeText} جديد للكتاب`;
        const message = `تم إضافة ${typeText} جديد للكتاب "${exchangeData.bookName}" من المستوى "${exchangeData.bookLevel}"`;
        
        // Create notification for all users except the creator
        const allUsersSnapshot = await usersCollection.where('isActive', '==', true).get();
        
        const notificationPromises = [];
        allUsersSnapshot.forEach(userDoc => {
          const userId = userDoc.id;
          // Don't send notification to the creator
          if (userId !== exchangeData.userId) {
            notificationPromises.push(
              createNotification('new_exchange', title, message, userId, {
                exchangeId: exchangeData.exchangeId,
                bookName: exchangeData.bookName,
                bookLevel: exchangeData.bookLevel,
                count: exchangeData.count,
                type: exchangeData.type,
                userName: exchangeData.userName,
                userEmail: exchangeData.userEmail,
                userPhone: exchangeData.userPhone,
                bookImageUrl: exchangeData.bookImageUrl
              })
            );
          }
        });
        
        await Promise.all(notificationPromises);
      } catch (error) {
        console.error('Error creating new exchange notification:', error);
      }
    }
    
    // Delete notifications related to a deleted exchange
    async function deleteRelatedNotifications(exchangeId) {
      try {
        // البحث عن جميع الإشعارات المرتبطة بهذا الإعلان
        const notificationsQuery = await notificationsCollection
          .where('type', '==', 'new_exchange')
          .get();
        
        const batch = db.batch();
        let deletedCount = 0;
        
        notificationsQuery.forEach(doc => {
          const notification = doc.data();
          // التحقق من وجود relatedData وexchangeId
          if (notification.relatedData && notification.relatedData.exchangeId === exchangeId) {
            batch.delete(doc.ref);
            deletedCount++;
          }
        });
        
        // البحث عن إشعارات انتهاء الصلاحية المرتبطة بنفس الإعلان
        const expiryNotificationsQuery = await notificationsCollection
          .where('type', '==', 'expiry_warning')
          .get();
        
        expiryNotificationsQuery.forEach(doc => {
          const notification = doc.data();
          if (notification.relatedData && notification.relatedData.exchangeId === exchangeId) {
            batch.delete(doc.ref);
            deletedCount++;
          }
        });
        
        if (deletedCount > 0) {
          await batch.commit();
          console.log(`تم حذف ${deletedCount} إشعار مرتبط بالإعلان المحذوف`);
        }
      } catch (error) {
        console.error('Error deleting related notifications:', error);
      }
    }
    
    // Admin Messages Functions
    
    // Show admin message modal
    function showAdminMessageModal() {
      if (!isAdmin) {
        alert('غير مسموح لك بالوصول لهذه الميزة');
        return;
      }
      
      document.getElementById('adminMessageModal').style.display = 'flex';
      
      // Load users list for specific messaging
      loadUsersForMessaging();
      
      // Setup message type radio handlers
      setupMessageTypeHandlers();
      
      // Setup form handler
      document.getElementById('adminMessageForm').onsubmit = async function(e) {
        e.preventDefault();
        await sendAdminMessage();
      };
    }
    
    // Close admin message modal
    function closeAdminMessageModal() {
      document.getElementById('adminMessageModal').style.display = 'none';
      document.getElementById('adminMessageForm').reset();
      // Reset specific users group
      document.getElementById('specificUsersGroup').style.display = 'none';
      document.getElementById('messageTypeAll').checked = true;
    }
    
    // Setup message type handlers
    function setupMessageTypeHandlers() {
      const messageTypeAll = document.getElementById('messageTypeAll');
      const messageTypeSpecific = document.getElementById('messageTypeSpecific');
      const specificUsersGroup = document.getElementById('specificUsersGroup');
      
      messageTypeAll.addEventListener('change', function() {
        if (this.checked) {
          specificUsersGroup.style.display = 'none';
        }
      });
      
      messageTypeSpecific.addEventListener('change', function() {
        if (this.checked) {
          specificUsersGroup.style.display = 'block';
        }
      });
    }
    
    // Load users for messaging
    async function loadUsersForMessaging() {
      const usersList = document.getElementById('usersList');
      const selectedUsersCount = document.getElementById('selectedUsersCount');
      
      // إضافة event listener لحقل البحث عن المستخدمين
      const userSearchInput = document.getElementById('userSearchInput');
      if (userSearchInput) {
        userSearchInput.addEventListener('input', function() {
          const searchTerm = this.value.trim();
          if (searchTerm.length >= 2) {
            performUserSearch(searchTerm);
          } else {
            clearUserSearchSuggestions();
          }
        });
      }
      
      try {
        usersList.innerHTML = '<div style="text-align: center; color: #718096;">جاري تحميل المستخدمين...</div>';
        
        const usersSnapshot = await usersCollection
          .where('isActive', '==', true)
          .get();
        
        if (usersSnapshot.empty) {
          usersList.innerHTML = '<div style="text-align: center; color: #718096;">لا يوجد مستخدمون مفعلون</div>';
          return;
        }
        
        let usersHTML = '';
        const activeUsers = [];
        
        usersSnapshot.forEach(doc => {
          const userData = doc.data();
          const userId = doc.id;
          
          // Filter out admin users and collect active users
          if (!userData.isAdmin) {
            activeUsers.push({ id: userId, ...userData });
          }
        });
        
        // Sort users by name locally
        activeUsers.sort((a, b) => {
          const nameA = (a.name || 'بدون اسم').toLowerCase();
          const nameB = (b.name || 'بدون اسم').toLowerCase();
          return nameA.localeCompare(nameB);
        });
        
        activeUsers.forEach(user => {
          usersHTML += `
            <label style="display: flex; align-items: center; gap: 10px; padding: 8px; border-radius: 6px; cursor: pointer; transition: background-color 0.2s;" 
                   onmouseover="this.style.backgroundColor='#f7fafc'" 
                   onmouseout="this.style.backgroundColor='transparent'">
              <input type="checkbox" value="${user.id}" onchange="updateSelectedUsersCount()" style="transform: scale(1.2);">
              <div style="flex: 1;">
                <div style="font-weight: 600; color: #2d3748;">${user.name || 'بدون اسم'}</div>
                <div style="font-size: 0.85em; color: #718096;">${user.email}</div>
                ${user.phone ? `<div style="font-size: 0.85em; color: #718096;">${user.phone}</div>` : ''}
              </div>
            </label>
          `;
        });
        
        usersList.innerHTML = usersHTML;
        selectedUsersCount.textContent = '0';
        
      } catch (error) {
        console.error('Error loading users for messaging:', error);
        usersList.innerHTML = '<div style="text-align: center; color: #e53e3e;">خطأ في تحميل المستخدمين</div>';
      }
    }
    
    // البحث الذكي عن المستخدمين
    async function performUserSearch(searchTerm) {
      const suggestionsDiv = document.getElementById('userSearchSuggestions');
      if (!suggestionsDiv) return;
      
      try {
        const normalizedSearch = normalizeArabicText(searchTerm.toLowerCase());
        
        // البحث في المستخدمين المفعلين
        const usersSnapshot = await usersCollection
          .where('isActive', '==', true)
          .get();
        
        const suggestions = [];
        
        usersSnapshot.forEach(doc => {
          const userData = doc.data();
          const userId = doc.id;
          
          // تجاهل المدراء
          if (userData.isAdmin) return;
          
          const userName = userData.name || 'بدون اسم';
          const userEmail = userData.email || '';
          
          // تطبيق نفس خوارزمية البحث الذكي المستخدمة في البحث عن الكتب
          const normalizedName = normalizeArabicText(userName.toLowerCase());
          const normalizedEmail = normalizeArabicText(userEmail.toLowerCase());
          
          // البحث في الاسم والبريد الإلكتروني
          const nameMatch = normalizedName.includes(normalizedSearch) || 
                           calculateSimilarity(normalizedSearch, normalizedName) > 0.6;
          const emailMatch = normalizedEmail.includes(normalizedSearch);
          
          if (nameMatch || emailMatch) {
            const nameSimilarity = calculateSimilarity(normalizedSearch, normalizedName);
            const emailSimilarity = calculateSimilarity(normalizedSearch, normalizedEmail);
            const maxSimilarity = Math.max(nameSimilarity, emailSimilarity);
            
            suggestions.push({
              id: userId,
              name: userName,
              email: userEmail,
              phone: userData.phone || '',
              similarity: maxSimilarity,
              matchType: nameMatch ? 'name' : 'email'
            });
          }
        });
        
        // ترتيب النتائج حسب التشابه
        suggestions.sort((a, b) => b.similarity - a.similarity);
        
        // عرض النتائج
        if (suggestions.length > 0) {
          let html = '<div class="user-search-suggestion-title">اقتراحات المستخدمين:</div>';
          html += '<div class="user-search-suggestions-list">';
          
          suggestions.slice(0, 5).forEach(user => {
            html += `
              <button class="user-search-suggestion-item" onclick="selectUser('${user.id}', '${user.name}', '${user.email}')">
                <div>
                  <div class="user-suggestion-name">${user.name}</div>
                  <div class="user-suggestion-email">${user.email}</div>
                </div>
                <div style="font-size: 0.8em; opacity: 0.8;">اختر</div>
              </button>
            `;
          });
          
          html += '</div>';
          suggestionsDiv.innerHTML = html;
        } else {
          suggestionsDiv.innerHTML = '<div class="user-search-suggestion-title" style="color: #718096;">لا توجد نتائج مطابقة</div>';
        }
        
      } catch (error) {
        console.error('Error searching users:', error);
        suggestionsDiv.innerHTML = '<div class="user-search-suggestion-title" style="color: #e53e3e;">خطأ في البحث</div>';
      }
    }
    
    // مسح اقتراحات البحث عن المستخدمين
    function clearUserSearchSuggestions() {
      const suggestionsDiv = document.getElementById('userSearchSuggestions');
      if (suggestionsDiv) {
        suggestionsDiv.innerHTML = '';
      }
    }
    
    // اختيار مستخدم من نتائج البحث
    function selectUser(userId, userName, userEmail) {
      // البحث عن checkbox المستخدم وتحديده
      const userCheckbox = document.querySelector(`#usersList input[value="${userId}"]`);
      if (userCheckbox) {
        userCheckbox.checked = true;
        updateSelectedUsersCount();
        
        // مسح حقل البحث والاقتراحات
        const searchInput = document.getElementById('userSearchInput');
        if (searchInput) {
          searchInput.value = '';
        }
        clearUserSearchSuggestions();
        
        // التمرير إلى المستخدم المحدد
        const userLabel = userCheckbox.closest('label');
        if (userLabel) {
          userLabel.scrollIntoView({ behavior: 'smooth', block: 'center' });
          userLabel.style.backgroundColor = '#e6fffa';
          setTimeout(() => {
            userLabel.style.backgroundColor = 'transparent';
          }, 2000);
        }
        
        showTemporaryAlert(`تم اختيار المستخدم: ${userName}`, 'success', 2000);
      }
    }
    
    // Update selected users count
    function updateSelectedUsersCount() {
      const checkboxes = document.querySelectorAll('#usersList input[type="checkbox"]:checked');
      const count = checkboxes.length;
      document.getElementById('selectedUsersCount').textContent = count;
    }
    
    // Send admin message
    async function sendAdminMessage() {
      if (!isAdmin) {
        showTemporaryAlert('ليس لديك صلاحية لإرسال الرسائل', 'error');
        return;
      }
      
      const title = document.getElementById('adminMessageTitle').value.trim();
      const content = document.getElementById('adminMessageContent').value.trim();
      const isUrgent = document.getElementById('adminMessageUrgent').checked;
      const messageType = document.querySelector('input[name="messageType"]:checked').value;
      const attachmentFile = document.getElementById('adminMessageAttachment').files[0];
      
      if (!title || !content) {
        showTemporaryAlert('يرجى ملء جميع الحقول المطلوبة', 'error');
        return;
      }
      
      // Get selected users if specific messaging is chosen
      let targetUsers = null;
      if (messageType === 'specific') {
        const selectedCheckboxes = document.querySelectorAll('#usersList input[type="checkbox"]:checked');
        if (selectedCheckboxes.length === 0) {
          showTemporaryAlert('يرجى اختيار مستخدم واحد على الأقل', 'error');
          return;
        }
        targetUsers = Array.from(selectedCheckboxes).map(cb => cb.value);
      }
      
      try {
        showTemporaryAlert('جاري إرسال الرسالة...', 'info');
        
        let attachmentData = null;
        
        // Upload attachment if provided
        if (attachmentFile) {
          const attachmentUrl = await uploadMessageAttachment(attachmentFile);
          if (attachmentUrl) {
            attachmentData = {
              name: attachmentFile.name,
              size: attachmentFile.size,
              type: attachmentFile.type,
              url: attachmentUrl,
              isImage: attachmentFile.type.startsWith('image/')
            };
          }
        }
        
        // Create admin message document
        const messageData = {
          title: title,
          content: content,
          isUrgent: isUrgent,
          messageType: messageType,
          targetUsers: targetUsers, // null for all users, array of UIDs for specific users
          attachment: attachmentData,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          createdBy: {
            uid: currentUser.uid,
            name: currentUser.name || currentUser.displayName || 'المدير',
            email: currentUser.email
          },
          active: true
        };
        
        const messageDoc = await adminMessagesCollection.add(messageData);
        const messageId = messageDoc.id;
        
        const recipientText = messageType === 'all' ? 'جميع المستخدمين' : `${targetUsers.length} مستخدم محدد`;
        const attachmentText = attachmentData ? ' مع مرفق' : '';
        showTemporaryAlert(`تم إرسال الرسالة${attachmentText} بنجاح إلى ${recipientText}`, 'success');
        closeAdminMessageModal();
        
        // If urgent, show immediately to online users
        if (isUrgent) {
          // The message will be shown via the real-time listener
        }
        
      } catch (error) {
        console.error('Error sending admin message:', error);
        showTemporaryAlert('حدث خطأ في إرسال الرسالة', 'error');
      }
    }
    
    // Show admin message display modal
    function showAdminMessageDisplay(message) {
      document.getElementById('adminMessageDisplayTitle').textContent = message.title;
      document.getElementById('adminMessageDisplayContent').textContent = message.content;
      
      // Handle attachment display
      const attachmentDisplay = document.getElementById('adminMessageAttachmentDisplay');
      if (message.attachment) {
        document.getElementById('attachmentDisplayName').textContent = message.attachment.name;
        document.getElementById('attachmentDisplaySize').textContent = formatFileSize(message.attachment.size);
        document.getElementById('attachmentDisplayIcon').textContent = message.attachment.isImage ? '🖼️' : '📄';
        
        // Store attachment data for view/download functions
        window.currentMessageAttachment = message.attachment;
        
        // Show/hide view button based on file type
        const viewBtn = document.getElementById('viewAttachmentBtn');
        viewBtn.style.display = message.attachment.isImage ? 'inline-block' : 'none';
        
        attachmentDisplay.style.display = 'block';
      } else {
        attachmentDisplay.style.display = 'none';
      }
      
      document.getElementById('adminMessageDisplayModal').style.display = 'flex';
      
      // Mark message as read
      markAdminMessageAsRead(message.id);
    }
    
    // Close admin message display modal
    function closeAdminMessageDisplay() {
      document.getElementById('adminMessageDisplayModal').style.display = 'none';
    }
    
    // Mark admin message as read
    async function markAdminMessageAsRead(messageId) {
      if (!currentUser || !messageId) return;
      
      try {
        await userReadMessagesCollection.doc(currentUser.uid).set({
          readMessages: firebase.firestore.FieldValue.arrayUnion(messageId)
        }, { merge: true });
        
        userReadMessages.add(messageId);
        
        // Don't create duplicate notification when message is read
        // The notification was already created when the message was sent
      } catch (error) {
        console.error('Error marking message as read:', error);
      }
    }
    
    // Load user read messages
    async function loadUserReadMessages() {
      if (!currentUser) return;
      
      try {
        // Add retry mechanism with exponential backoff
        let retries = 3;
        let delay = 1000;
        
        while (retries > 0) {
          try {
            const userReadDoc = await userReadMessagesCollection.doc(currentUser.uid).get();
            if (userReadDoc.exists) {
              const data = userReadDoc.data();
              userReadMessages = new Set(data.readMessages || []);
            } else {
              userReadMessages = new Set();
            }
            return; // Success, exit retry loop
          } catch (innerError) {
            retries--;
            if (retries === 0) throw innerError;
            
            await new Promise(resolve => setTimeout(resolve, delay));
            delay *= 2; // Exponential backoff
          }
        }
      } catch (error) {
        console.error('Error loading read messages after retries:', error);
        userReadMessages = new Set(); // Fallback to empty set
      }
    }
    
    // Setup admin messages listener with enhanced error handling
    function setupAdminMessagesListener() {
      if (!currentUser) return;
      
      // Clean up existing listener
      if (adminMessagesListener) {
        try {
          adminMessagesListener();
        } catch (e) {
          console.warn('Error cleaning up admin messages listener:', e);
        }
        adminMessagesListener = null;
      }
      
      // Add longer delay to avoid Firebase initialization conflicts
      setTimeout(() => {
        try {
          adminMessagesListener = adminMessagesCollection
            .where('active', '==', true)
            .onSnapshot((snapshot) => {
              try {
                // Sort locally to avoid compound index requirement
                const messages = [];
                snapshot.forEach(doc => {
                  const data = doc.data();
                  if (data) {
                    messages.push({ id: doc.id, ...data });
                  }
                });
                
                // Sort by createdAt locally
                messages.sort((a, b) => {
                  const timeA = a.createdAt ? a.createdAt.toDate() : new Date(0);
                  const timeB = b.createdAt ? b.createdAt.toDate() : new Date(0);
                  return timeB - timeA;
                });
                
                const newMessages = [];
                
                messages.forEach(message => {
                  // Skip if user has already read this message
                  if (!userReadMessages.has(message.id)) {
                    // Check if message is targeted to this user
                    if (message.messageType === 'all' || 
                        (message.messageType === 'specific' && 
                         message.targetUsers && 
                         message.targetUsers.includes(currentUser.uid))) {
                      newMessages.push(message);
                    }
                  }
                });
                
                // Show urgent messages immediately (only if not already read and not admin)
                if (!isAdmin) {
                  for (const message of newMessages) {
                    if (message.isUrgent && !userReadMessages.has(message.id)) {
                      showAdminMessageDisplay(message);
                      break; // Show only one urgent message at a time
                    }
                  }
                }
                
                // Store non-urgent messages for login display
                pendingAdminMessages = newMessages.filter(msg => !msg.isUrgent);
              } catch (snapshotError) {
                console.error('Error processing admin messages snapshot:', snapshotError);
              }
            }, (error) => {
              console.error('Admin messages listener error:', error);
              // Don't retry automatically to avoid infinite loops
            });
        } catch (error) {
          console.error('Error setting up admin messages listener:', error);
        }
      }, 5000); // 5 second delay
    }
    
    // Check and show pending admin messages (called after login)
    async function checkPendingAdminMessages() {
      if (!currentUser) return;
      
      try {
        // Load user read messages first
        await loadUserReadMessages();
        
        // Add retry mechanism
        let retries = 3;
        let delay = 2000;
        
        while (retries > 0) {
          try {
            // Get all active admin messages
            const messagesQuery = await adminMessagesCollection
              .where('active', '==', true)
              .get();
              
            // Sort locally to avoid compound index requirement
            const allMessages = [];
            messagesQuery.forEach(doc => {
              allMessages.push({ id: doc.id, ...doc.data() });
            });
            
            allMessages.sort((a, b) => {
              const timeA = a.createdAt ? a.createdAt.toDate() : new Date(0);
              const timeB = b.createdAt ? b.createdAt.toDate() : new Date(0);
              return timeB - timeA;
            });
            
            const unreadList = [];
            allMessages.forEach(message => {
              if (!userReadMessages.has(message.id)) {
                unreadList.push(message);
              }
            });
            
            // Fallback: populate messages list and badge for the dropdown immediately
            // so that normal (non-urgent) messages appear in the messages icon.
            messages = allMessages
              .filter(m => {
                // Filter out deleted messages
                if (m.deletedBy && m.deletedBy[currentUser.uid]) return false;
                
                // Filter by message targeting
                if (m.messageType === 'all') return true;
                if (m.messageType === 'specific' && m.targetUsers && m.targetUsers.includes(currentUser.uid)) return true;
                
                // For backward compatibility with old messages without messageType
                if (!m.messageType) return true;
                
                return false;
              })
              .map(m => ({
                id: m.id,
                ...m,
                read: !!(m.readBy && m.readBy[currentUser.uid])
              }));
            // Sort locally by creation time
            messages.sort((a, b) => {
              const timeA = a.createdAt ? a.createdAt.toDate() : new Date(0);
              const timeB = b.createdAt ? b.createdAt.toDate() : new Date(0);
              return timeB - timeA;
            });
            // Count unread for badge and update UI
            unreadMessages = messages.filter(m => !m.read).length;

            updateMessagesBadge();
            if (isMessagesDropdownOpen) {
              renderMessagesList();
            }

            // Show only urgent messages immediately (only if not already read and not admin)
            if (!isAdmin) {
              const urgentMessages = unreadList.filter(msg => msg.isUrgent);
              if (urgentMessages.length > 0) {
                // Wait a bit for the UI to load then show the most recent urgent message
                setTimeout(() => {
                  const urgentMessage = urgentMessages[0]; // Most recent urgent message
                  if (urgentMessage && !userReadMessages.has(urgentMessage.id)) {
                    showAdminMessageDisplay(urgentMessage);
                  }
                }, 1000);
              }
            }
            return; // Success, exit retry loop
          } catch (innerError) {
            retries--;
            if (retries === 0) throw innerError;
            
            await new Promise(resolve => setTimeout(resolve, delay));
            delay *= 2;
          }
        }
        
      } catch (error) {
        console.error('Error checking pending admin messages after retries:', error);
      }
    }
    
    // Close dropdown when clicking outside
    document.addEventListener('click', (event) => {
      const notificationsContainer = document.querySelector('.notifications-container');
      if (notificationsContainer && !notificationsContainer.contains(event.target)) {
        if (isNotificationsDropdownOpen) {
          toggleNotifications();
        }
      }
      
      // Close messages dropdown when clicking outside
      const messagesContainers = document.querySelectorAll('.notifications-container');
      messagesContainers.forEach(container => {
        if (container.querySelector('#messagesBtn') && !container.contains(event.target)) {
          if (isMessagesDropdownOpen) {
            toggleMessages();
          }
        }
      });
    });

    // Messages System Functions
    
    // Toggle messages dropdown
    function toggleMessages() {
      const dropdown = document.getElementById('messagesDropdown');
      if (!dropdown) return;
      
      isMessagesDropdownOpen = !isMessagesDropdownOpen;
      
      if (isMessagesDropdownOpen) {
        dropdown.classList.add('show');
        messagesLoaded = 0;
        renderMessagesList();
        
        // Mark all messages as read immediately when opening messages
        markAllMessagesAsRead();
        
        // Reset badge count immediately when opening messages
        unreadMessages = 0;
        updateMessagesBadge();
      } else {
        dropdown.classList.remove('show');
      }
    }
    
    // Update messages badge
    function updateMessagesBadge() {
      // Update sidebar messages badge
      const sidebarBadge = document.getElementById('sidebar-messagesBadge');
      
      if (sidebarBadge) {
        if (unreadMessages > 0) {
          sidebarBadge.textContent = unreadMessages > 99 ? '99+' : unreadMessages;
          sidebarBadge.style.display = 'flex';
        } else {
          sidebarBadge.style.display = 'none';
        }
      }
      
      // Update original badge if it exists (for compatibility)
      const originalBadge = document.getElementById('messagesBadge');
      if (originalBadge) {
        if (unreadMessages > 0) {
          originalBadge.textContent = unreadMessages > 99 ? '99+' : unreadMessages;
          originalBadge.style.display = 'flex';
        } else {
          originalBadge.style.display = 'none';
        }
      }
    }
    
    // Render messages list
    function renderMessagesList() {
      const listElement = document.getElementById('messagesList');
      const loadMoreElement = document.getElementById('messagesLoadMore');
      
      if (!listElement) return;
      
      if (messages.length === 0) {
        listElement.innerHTML = '<div class="notifications-empty">لا توجد رسائل</div>';
        if (loadMoreElement) loadMoreElement.style.display = 'none';
        return;
      }
      
      const endIndex = Math.min(messagesLoaded + messagesPerPage, messages.length);
      const visibleMessages = messages.slice(0, endIndex);
      
      listElement.innerHTML = '';
      
      visibleMessages.forEach(message => {
        const item = document.createElement('div');
        item.className = `notification-item ${!message.read ? 'unread' : ''}`;
        
        const timeText = formatMessageTime(message);
        
        // تحديد نوع الرسالة وعرضها بناءً على ما إذا كان المستخدم مدير أم لا
        let badgeText = 'رسالة إدارية';
        let messageContent = message.content || message.message || '';
        let senderInfo = '';
        
        if (isAdmin && message.type === 'user_to_admin') {
          badgeText = 'رسالة من مستخدم';
          senderInfo = `<div class="notification-sender">من: ${message.fromUserName} (${message.fromUserEmail})</div>`;
        }
        
        item.innerHTML = `
          <span class="notification-type-badge ${message.type === 'user_to_admin' ? 'notification-type-user-message' : 'notification-type-admin-message'}">${badgeText}</span>
          <div class="notification-content">
            <div class="notification-title">${message.title}</div>
            ${senderInfo}
            <div class="notification-message">${messageContent.substring(0, 100)}${messageContent.length > 100 ? '...' : ''}</div>
            <div class="notification-time">${timeText}</div>
          </div>
          <div style="position: absolute; top: 8px; left: 8px;">
            <button onclick="deleteMessage('${message.id}', event)" style="background: #e53e3e; color: white; border: none; border-radius: 50%; width: 20px; height: 20px; font-size: 0.7em; cursor: pointer;" title="حذف الرسالة">×</button>
          </div>
        `;
        
        // Add click handler to show details
        item.onclick = () => showMessageDetail(message);
        
        listElement.appendChild(item);
      });
      
      messagesLoaded = endIndex;
      
      // Show/hide load more button
      if (loadMoreElement) {
        if (messagesLoaded < messages.length) {
          loadMoreElement.style.display = 'block';
        } else {
          loadMoreElement.style.display = 'none';
        }
      }
    }
    
    // Format message time
    function formatMessageTime(message) {
      let timeText = 'الآن';
      if (message.createdAt) {
        const messageTime = message.createdAt.toDate();
        const now = new Date();
        const diffMs = now - messageTime;
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);
        
        if (diffMins < 1) {
          timeText = 'الآن';
        } else if (diffMins < 60) {
          timeText = `منذ ${diffMins} دقيقة`;
        } else if (diffHours < 24) {
          timeText = `منذ ${diffHours} ساعة`;
        } else {
          timeText = `منذ ${diffDays} يوم`;
        }
      }
      return timeText;
    }
    
    // Show message detail
    function showMessageDetail(message) {
      const modal = document.getElementById('notificationDetailModal');
      const title = document.getElementById('notificationDetailTitle');
      const messageDiv = document.getElementById('notificationDetailMessage');
      const info = document.getElementById('notificationDetailInfo');
      
      title.textContent = message.title;
      messageDiv.textContent = message.content || message.message || '';
      
      // Show additional info
      info.style.display = 'block';
      let messageTypeText = 'رسالة إدارية';
      let additionalInfo = '';
      
      if (isAdmin && message.type === 'user_to_admin') {
        messageTypeText = 'رسالة من مستخدم';
        additionalInfo = `
          <div class="notification-detail-info-item">
            <span class="notification-detail-info-label">من:</span>
            <span class="notification-detail-info-value">${message.fromUserName}</span>
          </div>
          <div class="notification-detail-info-item">
            <span class="notification-detail-info-label">البريد الإلكتروني:</span>
            <span class="notification-detail-info-value">${message.fromUserEmail}</span>
          </div>
          <div class="notification-detail-info-item">
            <span class="notification-detail-info-label">رقم الهاتف:</span>
            <span class="notification-detail-info-value">${message.fromUserPhone || 'غير متوفر'}</span>
          </div>
        `;
      }
      
      info.innerHTML = `
        <div class="notification-detail-info-item">
          <span class="notification-detail-info-label">التاريخ:</span>
          <span class="notification-detail-info-value">${formatMessageTime(message)}</span>
        </div>
        <div class="notification-detail-info-item">
          <span class="notification-detail-info-label">النوع:</span>
          <span class="notification-detail-info-value">${messageTypeText}</span>
        </div>
        ${additionalInfo}
      `;
      
      // Handle attachment display in message detail
      const attachmentDisplay = document.getElementById('messageAttachmentDisplay');
      if (message.attachment) {
        document.getElementById('messageAttachmentDisplayName').textContent = message.attachment.name;
        document.getElementById('messageAttachmentDisplaySize').textContent = formatFileSize(message.attachment.size);
        document.getElementById('messageAttachmentDisplayIcon').textContent = message.attachment.isImage ? '🖼️' : '📄';
        
        // Store attachment data for view/download functions
        window.currentMessageAttachment = message.attachment;
        
        // Show/hide view button based on file type
        const viewBtn = document.getElementById('viewMessageAttachmentBtn');
        viewBtn.style.display = message.attachment.isImage ? 'inline-block' : 'none';
        
        attachmentDisplay.style.display = 'block';
      } else {
        attachmentDisplay.style.display = 'none';
      }
      
      // Mark message as read if it's a user-to-admin message
      if (isAdmin && message.type === 'user_to_admin' && !message.read) {
        markUserMessageAsRead(message.id);
      }
      
      modal.style.display = 'flex';
    }
    
    // Mark user-to-admin message as read
    async function markUserMessageAsRead(messageId) {
      if (!isAdmin) return;
      
      try {
        await adminMessagesCollection.doc(messageId).update({
          isRead: true,
          readAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      } catch (error) {
        console.error('Error marking user message as read:', error);
      }
    }
    
    // Load more messages
    function loadMoreMessages() {
      renderMessagesList();
    }
    
    // Mark all messages as read
    async function markAllMessagesAsRead() {
      if (!currentUser || messages.length === 0) return;
      
      try {
        const batch = db.batch();
        const unreadMessageIds = messages.filter(m => !m.read).map(m => m.id);
        
        unreadMessageIds.forEach(messageId => {
          const messageRef = adminMessagesCollection.doc(messageId);
          batch.update(messageRef, { 
            [`readBy.${currentUser.uid}`]: firebase.firestore.FieldValue.serverTimestamp() 
          });
        });
        
        if (unreadMessageIds.length > 0) {
          await batch.commit();
        }
      } catch (error) {
        console.error('Error marking messages as read:', error);
      }
    }
    
    // Delete single message
    async function deleteMessage(messageId, event) {
      event.stopPropagation();
      
      if (!confirm('هل تريد حذف هذه الرسالة؟')) return;
      
      try {
        // Remove message from user's read messages
        await adminMessagesCollection.doc(messageId).update({
          [`deletedBy.${currentUser.uid}`]: firebase.firestore.FieldValue.serverTimestamp()
        });
        
        showTemporaryAlert('تم حذف الرسالة بنجاح', 'success');
      } catch (error) {
        console.error('Error deleting message:', error);
        showTemporaryAlert('حدث خطأ في حذف الرسالة', 'error');
      }
    }
    
    // Clear all messages
    async function clearAllMessages() {
      if (!currentUser || messages.length === 0) return;
      
      if (!confirm('هل تريد حذف جميع الرسائل؟')) return;
      
      try {
        const batch = db.batch();
        
        messages.forEach(message => {
          const messageRef = adminMessagesCollection.doc(message.id);
          batch.update(messageRef, {
            [`deletedBy.${currentUser.uid}`]: firebase.firestore.FieldValue.serverTimestamp()
          });
        });
        
        await batch.commit();
        showTemporaryAlert('تم حذف جميع الرسائل بنجاح', 'success');
      } catch (error) {
        console.error('Error clearing all messages:', error);
        showTemporaryAlert('حدث خطأ في حذف الرسائل', 'error');
      }
    }
    
    // Setup admin messages listener for admin users
    function setupAdminMessagesListener() {
      if (!currentUser || !isAdmin) return;
      
      // Clean up existing listener
      if (messagesListener) {
        try {
          messagesListener();
        } catch (e) {
          console.warn('Error cleaning up admin messages listener:', e);
        }
        messagesListener = null;
      }
      
      // Listen for user-to-admin messages (fetch and filter client-side to avoid index requirement)
      messagesListener = adminMessagesCollection
        .orderBy('timestamp', 'desc')
        .limit(100)
        .onSnapshot((snapshot) => {
          try {
            messages = [];
            snapshot.forEach(doc => {
              const data = doc.data();
              // Filter for user-to-admin messages only
              if (data && data.type === 'user_to_admin' && !data.deletedBy?.[currentUser.uid]) {
                messages.push({ 
                  id: doc.id, 
                  ...data, 
                  read: data.isRead || false
                });
              }
            });
            
            // Count unread messages
            unreadMessages = messages.filter(m => !m.read).length;
            
            // Update UI
            updateMessagesBadge();
            
            // If dropdown is open, refresh the list
            if (isMessagesDropdownOpen) {
              renderMessagesList();
            }
          } catch (error) {
            console.error('Error processing admin messages snapshot:', error);
          }
        }, (error) => {
          console.error('Admin messages listener error:', error);
        });
    }
    
    // Setup messages listener
    function setupMessagesListener() {
      if (!currentUser) {
        console.log('❌ setupMessagesListener: No current user');
        return;
      }
      
      // For admin users, load user-to-admin messages instead
      if (isAdmin) {
        setupAdminMessagesListener();
        return;
      }
      
      // Clean up existing listener
      if (messagesListener) {
        try {
          messagesListener();
        } catch (e) {
          console.warn('Error cleaning up messages listener:', e);
        }
        messagesListener = null;
      }
      
      // Add delay and retry mechanism
      setTimeout(() => {
        try {

          messagesListener = adminMessagesCollection
            .where('active', '==', true)
            .onSnapshot((snapshot) => {
              try {
                
                messages = [];
                snapshot.forEach(doc => {
                  const data = doc.data();
                  
                  
                  if (data && !data.deletedBy?.[currentUser.uid]) {
                    // Check if message is targeted to this user
                    const isTargeted = data.messageType === 'all' || 
                                     (data.messageType === 'specific' && 
                                      data.targetUsers && 
                                      data.targetUsers.includes(currentUser.uid)) ||
                                     (!data.messageType); // backward compatibility
                    
                    if (isTargeted) {
                      const isRead = data.readBy?.[currentUser.uid] ? true : false;
                      const messageType = data.isUrgent ? 'عاجلة' : 'عادية';
                      
                      messages.push({ 
                        id: doc.id, 
                        ...data, 
                        read: isRead 
                      });
                    }
                  }
                });
                

                
                // Sort locally by creation time
                messages.sort((a, b) => {
                  const timeA = a.createdAt ? a.createdAt.toDate() : new Date(0);
                  const timeB = b.createdAt ? b.createdAt.toDate() : new Date(0);
                  return timeB - timeA;
                });
                
                // Count unread messages
                unreadMessages = messages.filter(m => !m.read).length;

                
                // Update UI
                updateMessagesBadge();
                
                // If dropdown is open, refresh the list
                if (isMessagesDropdownOpen) {
                  renderMessagesList();
                }
              } catch (snapshotError) {
                console.error('Error processing messages snapshot:', snapshotError);
              }
            }, (error) => {
              console.error('Messages listener error:', error);
            });
        } catch (error) {
          console.error('Error setting up messages listener:', error);
        }
      }, 3500); // 3.5 second delay (slightly after notifications)
    }
    
    // Expose notifications functions to window
    window.toggleNotifications = toggleNotifications;
    window.loadMoreNotifications = loadMoreNotifications;
    window.clearAllNotifications = clearAllNotifications;
    window.closeNotificationDetail = closeNotificationDetail;
    
    // Expose admin message functions to window
    window.showAdminMessageModal = showAdminMessageModal;
    window.closeAdminMessageModal = closeAdminMessageModal;
    window.closeAdminMessageDisplay = closeAdminMessageDisplay;
    
    // Expose exchange functions to window
    window.showExchangeForm = showExchangeForm;
    window.closeExchangeModal = closeExchangeModal;
    window.deleteExchange = deleteExchange;
    // تعريف وظيفة switchExchangeTab في النافذة العامة
    // نستخدم نفس الاسم للوظيفة الداخلية والعامة
    const originalSwitchExchangeTab = switchExchangeTab;
    window.switchExchangeTab = switchExchangeTab;

    // متغير لتتبع نوع التبادل الحالي (تم نقله لأعلى لتجنب التكرار)
    let currentExchangeType = 'my';

    // دوال إدارة الحذف المجمع
    function toggleSelectAll() {
      const selectAllCheckbox = document.getElementById('selectAllExchanges');
      const exchangeCheckboxes = document.querySelectorAll('.exchange-checkbox');

      exchangeCheckboxes.forEach(checkbox => {
        checkbox.checked = selectAllCheckbox.checked;
      });

      updateSelectedCount();
    }

    function updateSelectedCount() {
      const selectedCheckboxes = document.querySelectorAll('.exchange-checkbox:checked');
      const deleteSelectedBtn = document.getElementById('deleteSelectedBtn');
      const selectedCountSpan = document.getElementById('selectedCount');

      const count = selectedCheckboxes.length;
      selectedCountSpan.textContent = `${count} محدد`;

      if (count > 0) {
        deleteSelectedBtn.disabled = false;
        deleteSelectedBtn.style.opacity = '1';
      } else {
        deleteSelectedBtn.disabled = true;
        deleteSelectedBtn.style.opacity = '0.5';
      }
    }

    async function deleteSelectedExchanges() {
      const selectedCheckboxes = document.querySelectorAll('.exchange-checkbox:checked');
      const exchangeIds = Array.from(selectedCheckboxes).map(cb => cb.dataset.exchangeId);

      if (exchangeIds.length === 0) {
        showTemporaryAlert('لم يتم تحديد أي إعلانات للحذف', 'error');
        return;
      }

      const confirmMessage = `هل أنت متأكد من حذف ${exchangeIds.length} إعلان محدد؟`;
      if (!confirm(confirmMessage)) return;

      try {
        showTemporaryAlert('جاري حذف الإعلانات المحددة...', 'info');

        for (const exchangeId of exchangeIds) {
          await exchangeCollection.doc(exchangeId).delete();
          await deleteRelatedNotifications(exchangeId);
        }

        showTemporaryAlert(`تم حذف ${exchangeIds.length} إعلان بنجاح`, 'success');

        // إعادة تعيين حالة التحديد
        document.getElementById('selectAllExchanges').checked = false;
        updateSelectedCount();

        // تحديث الإحصائيات والعرض
        await countExchangeStats();
        loadExchangeListings(currentExchangeType);

      } catch (error) {
        console.error('Error deleting selected exchanges:', error);
        showTemporaryAlert('حدث خطأ في حذف بعض الإعلانات', 'error');
      }
    }

    async function deleteAllMyExchanges() {
      if (!currentUser) {
        showTemporaryAlert('يجب تسجيل الدخول أولاً', 'error');
        return;
      }

      const confirmMessage = 'هل أنت متأكد من حذف جميع إعلاناتك؟ هذا الإجراء لا يمكن التراجع عنه!';
      if (!confirm(confirmMessage)) return;

      try {
        showTemporaryAlert('جاري حذف جميع إعلاناتك...', 'info');

        // جلب جميع إعلانات المستخدم
        const userExchanges = await exchangeCollection
          .where('userId', '==', currentUser.uid)
          .get();

        if (userExchanges.empty) {
          showTemporaryAlert('لا توجد إعلانات لحذفها', 'info');
          return;
        }

        const batch = db.batch();
        let deletedCount = 0;

        for (const doc of userExchanges.docs) {
          batch.delete(exchangeCollection.doc(doc.id));
          await deleteRelatedNotifications(doc.id);
          deletedCount++;
        }

        await batch.commit();

        showTemporaryAlert(`تم حذف ${deletedCount} إعلان بنجاح`, 'success');

        // إعادة تعيين حالة التحديد
        document.getElementById('selectAllExchanges').checked = false;
        updateSelectedCount();

        // تحديث الإحصائيات والعرض
        await countExchangeStats();
        loadExchangeListings(currentExchangeType);

      } catch (error) {
        console.error('Error deleting all exchanges:', error);
        showTemporaryAlert('حدث خطأ في حذف الإعلانات', 'error');
      }
    }

    // دالة للتحقق من وجود الصورة في قوائم الكتب الرسمية
    function isImageInOfficialBooks(bookName, levelName, imageUrl) {
      const level = levels.find(l => l.name === levelName);
      if (!level) return false;
      
      // التحقق من وجود الصورة في booksWithImages
      if (level.booksWithImages && level.booksWithImages[bookName] === imageUrl) {
        return true;
      }
      
      // التحقق من وجود الصورة في bookImages
      if (level.bookImages && level.bookImages[bookName] === imageUrl) {
        return true;
      }
      
      return false;
    }

    // دالة تحديث صور الإعلانات عند تعديل صورة كتاب في القائمة الرسمية
    async function updateExchangeImageUrls(bookName, levelName, newImageUrl) {
      try {
        // البحث عن جميع الإعلانات التي تحتوي على هذا الكتاب والمستوى
        const exchangesQuery = await exchangeCollection
          .where('bookName', '==', bookName)
          .where('bookLevel', '==', levelName)
          .get();
        
        if (exchangesQuery.empty) {
          console.log('لا توجد إعلانات مرتبطة بهذا الكتاب');
          return;
        }
        
        // تحديث كل إعلان
        const batch = firebase.firestore().batch();
        let updatedCount = 0;
        
        exchangesQuery.forEach(doc => {
          const exchangeData = doc.data();
          
          // تحديث رابط الصورة فقط إذا كان الإعلان لا يحتوي على صورة خاصة به
          // أو إذا كانت صورته تطابق الصورة القديمة من القائمة الرسمية
          if (!exchangeData.bookImageUrl || 
              (exchangeData.bookImageUrl && isImageInOfficialBooks(bookName, levelName, exchangeData.bookImageUrl))) {
            
            batch.update(doc.ref, {
              bookImageUrl: newImageUrl,
              updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            updatedCount++;
          }
        });
        
        if (updatedCount > 0) {
          await batch.commit();
          console.log(`تم تحديث ${updatedCount} إعلان بالصورة الجديدة`);
        }
        
      } catch (error) {
        console.error('خطأ في تحديث صور الإعلانات:', error);
      }
    }

    // دالة تنظيف الإعلانات المنتهية الصلاحية
    async function cleanupExpiredExchanges() {
      try {
        const now = new Date();
        const expiredExchanges = await exchangeCollection
          .where('expiryDate', '<=', now)
          .get();
        
        if (expiredExchanges.empty) {
          console.log('لا توجد إعلانات منتهية الصلاحية للحذف');
          return;
        }
        
        const batch = db.batch();
        let deletedCount = 0;
        
        for (const doc of expiredExchanges.docs) {
          const exchangeData = doc.data();
          
          // حذف صورة الإعلان إذا كانت موجودة ولا تنتمي لقائمة الكتب الرسمية
          if (exchangeData.bookImageUrl && !isImageInOfficialBooks(exchangeData.bookName, exchangeData.bookLevel, exchangeData.bookImageUrl)) {
            try {
              const imageRef = firebase.storage().refFromURL(exchangeData.bookImageUrl);
              await imageRef.delete();
            } catch (imageError) {
              console.log('تعذر حذف الصورة:', imageError);
            }
          }
          
          // حذف الإشعارات المرتبطة
          await deleteRelatedNotifications(doc.id);
          
          // إضافة الإعلان للحذف المجمع
          batch.delete(exchangeCollection.doc(doc.id));
          deletedCount++;
        }
        
        await batch.commit();
        console.log(`تم حذف ${deletedCount} إعلان منتهي الصلاحية`);
        
        // تحديث الإحصائيات
        await countExchangeStats();
        
      } catch (error) {
        console.error('خطأ في تنظيف الإعلانات المنتهية الصلاحية:', error);
      }
    }
    
    // تشغيل تنظيف الإعلانات المنتهية الصلاحية كل ساعة
    setInterval(cleanupExpiredExchanges, 60 * 60 * 1000); // كل ساعة
    
    // تشغيل التنظيف عند بدء التطبيق
    setTimeout(cleanupExpiredExchanges, 5000); // بعد 5 ثوان من بدء التطبيق
    
    // دوال إدارة الحذف المجمع للأدمن
    function adminToggleSelectAll() {
      const selectAllCheckbox = document.getElementById('adminSelectAllExchanges');
      const exchangeCheckboxes = document.querySelectorAll('.admin-exchange-checkbox');
      
      exchangeCheckboxes.forEach(checkbox => {
        checkbox.checked = selectAllCheckbox.checked;
      });
      
      adminUpdateSelectedCount();
    }
    
    function adminUpdateSelectedCount() {
      const selectedCheckboxes = document.querySelectorAll('.admin-exchange-checkbox:checked');
      const deleteSelectedBtn = document.getElementById('adminDeleteSelectedBtn');
      const selectedCountSpan = document.getElementById('adminSelectedCount');
      
      const count = selectedCheckboxes.length;
      selectedCountSpan.textContent = `${count} محدد`;
      
      if (count > 0) {
        deleteSelectedBtn.disabled = false;
        deleteSelectedBtn.style.opacity = '1';
      } else {
        deleteSelectedBtn.disabled = true;
        deleteSelectedBtn.style.opacity = '0.5';
      }
    }
    
    async function adminDeleteSelectedExchanges() {
      if (!isAdmin) {
        showTemporaryAlert('ليس لديك صلاحية لحذف إعلانات المستخدمين', 'error');
        return;
      }
      
      const selectedCheckboxes = document.querySelectorAll('.admin-exchange-checkbox:checked');
      const exchangeIds = Array.from(selectedCheckboxes).map(cb => cb.dataset.exchangeId);
      
      if (exchangeIds.length === 0) {
        showTemporaryAlert('لم يتم تحديد أي إعلانات للحذف', 'error');
        return;
      }
      
      const confirmMessage = `هل أنت متأكد من حذف ${exchangeIds.length} إعلان محدد؟ (بصلاحية المدير)`;
      if (!confirm(confirmMessage)) return;
      
      try {
        showTemporaryAlert('جاري حذف الإعلانات المحددة...', 'info');
        
        for (const exchangeId of exchangeIds) {
          // جلب بيانات الإعلان قبل الحذف
          const exchangeDoc = await exchangeCollection.doc(exchangeId).get();
          if (exchangeDoc.exists) {
            const exchangeData = exchangeDoc.data();
            
            // حذف صورة الإعلان إذا كانت موجودة ولا تنتمي لقائمة الكتب الرسمية
            if (exchangeData.bookImageUrl && !isImageInOfficialBooks(exchangeData.bookName, exchangeData.bookLevel, exchangeData.bookImageUrl)) {
              try {
                const imageRef = firebase.storage().refFromURL(exchangeData.bookImageUrl);
                await imageRef.delete();
              } catch (imageError) {
                console.log('تعذر حذف الصورة:', imageError);
              }
            }
          }
          
          await exchangeCollection.doc(exchangeId).delete();
          await deleteRelatedNotifications(exchangeId);
        }
        
        showTemporaryAlert(`تم حذف ${exchangeIds.length} إعلان بنجاح (بصلاحية المدير)`, 'success');
        
        // إعادة تعيين حالة التحديد
        document.getElementById('adminSelectAllExchanges').checked = false;
        adminUpdateSelectedCount();
        
        // تحديث الإحصائيات والعرض
        await countExchangeStats();
        loadExchangeListings(currentExchangeType);
        
      } catch (error) {
        console.error('Error deleting selected exchanges:', error);
        showTemporaryAlert('حدث خطأ في حذف بعض الإعلانات', 'error');
      }
    }
    
    // ربط الدوال بالنافذة العامة
    window.toggleSelectAll = toggleSelectAll;
    window.updateSelectedCount = updateSelectedCount;
    window.deleteSelectedExchanges = deleteSelectedExchanges;
    window.deleteAllMyExchanges = deleteAllMyExchanges;
    window.adminToggleSelectAll = adminToggleSelectAll;
    window.adminUpdateSelectedCount = adminUpdateSelectedCount;
    window.adminDeleteSelectedExchanges = adminDeleteSelectedExchanges;
    window.updateExchangeImageUrls = updateExchangeImageUrls;
    window.isImageInOfficialBooks = isImageInOfficialBooks;
    window.cleanupExpiredExchanges = cleanupExpiredExchanges;
    
    // Message attachment functions
    async function uploadMessageAttachment(file) {
      const maxSize = file.type.startsWith('image/') ? 1024 * 1024 : 2 * 1024 * 1024;
      if (file.size > maxSize) {
        const limit = file.type.startsWith('image/') ? '1 ميجابايت' : '2 ميجابايت';
        showTemporaryAlert(`حجم الملف يتجاوز الحد المسموح (${limit})`, 'error');
        return null;
      }
      
      const fileName = `messages/${Date.now()}_${file.name}`;
      const storageRef = firebase.storage().ref().child(fileName);
      const snapshot = await storageRef.put(file);
      return await snapshot.ref.getDownloadURL();
    }
    
    function formatFileSize(bytes) {
      if (bytes === 0) return '0 بايت';
      const k = 1024;
      const sizes = ['بايت', 'كيلوبايت', 'ميجابايت'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }
    
    function viewMessageAttachment() {
      if (window.currentMessageAttachment && window.currentMessageAttachment.isImage) {
        showImageModal(window.currentMessageAttachment.url, window.currentMessageAttachment.name);
      }
    }
    
    function downloadMessageAttachment() {
      if (window.currentMessageAttachment) {
        try {
          showTemporaryAlert('جاري تحميل الملف...', 'info');
          
          // Create download link directly with Firebase Storage URL
          const link = document.createElement('a');
          link.href = window.currentMessageAttachment.url;
          link.download = window.currentMessageAttachment.name;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          
          // Trigger download
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          
          showTemporaryAlert('تم بدء تحميل الملف', 'success');
        } catch (error) {
          console.error('Error downloading file:', error);
          showTemporaryAlert('حدث خطأ في تحميل الملف', 'error');
        }
      }
    }
    
    function removeAttachment() {
      document.getElementById('adminMessageAttachment').value = '';
      document.getElementById('attachmentPreview').style.display = 'none';
    }
    
    // Attachment preview handler
    document.getElementById('adminMessageAttachment').onchange = function(e) {
      const file = e.target.files[0];
      if (!file) return;
      
      const maxSize = file.type.startsWith('image/') ? 1024 * 1024 : 2 * 1024 * 1024;
      if (file.size > maxSize) {
        const limit = file.type.startsWith('image/') ? '1 ميجابايت' : '2 ميجابايت';
        showTemporaryAlert(`حجم الملف يتجاوز الحد المسموح (${limit})`, 'error');
        this.value = '';
        return;
      }
      
      document.getElementById('attachmentName').textContent = file.name;
      document.getElementById('attachmentSize').textContent = formatFileSize(file.size);
      document.getElementById('attachmentIcon').textContent = file.type.startsWith('image/') ? '🖼️' : '📄';
      document.getElementById('attachmentPreview').style.display = 'block';
    };
    
    // Contact admin attachment preview handler
    document.getElementById('contactAdminAttachment').onchange = function(e) {
      const file = e.target.files[0];
      if (!file) return;
      
      const maxSize = file.type.startsWith('image/') ? 1024 * 1024 : 2 * 1024 * 1024;
      if (file.size > maxSize) {
        const limit = file.type.startsWith('image/') ? '1 ميجابايت' : '2 ميجابايت';
        showTemporaryAlert(`حجم الملف يتجاوز الحد المسموح (${limit})`, 'error');
        this.value = '';
        return;
      }
      
      document.getElementById('contactAttachmentName').textContent = file.name;
      document.getElementById('contactAttachmentSize').textContent = formatFileSize(file.size);
      document.getElementById('contactAttachmentIcon').textContent = file.type.startsWith('image/') ? '🖼️' : '📄';
      document.getElementById('contactAttachmentPreview').style.display = 'block';
    };
    
    function removeContactAttachment() {
      document.getElementById('contactAdminAttachment').value = '';
      document.getElementById('contactAttachmentPreview').style.display = 'none';
    }
    
    window.uploadMessageAttachment = uploadMessageAttachment;
    window.viewMessageAttachment = viewMessageAttachment;
    window.downloadMessageAttachment = downloadMessageAttachment;
    window.removeAttachment = removeAttachment;
    window.removeContactAttachment = removeContactAttachment;
    window.showExchangeOption = showExchangeOption;
    window.loadExistingBooks = loadExistingBooks;

    // وظيفة إعادة تحميل التطبيق بالكامل
    function refreshApp() {
      try {
        // تغيير حالة زر التحديث
        const refreshBtn = document.getElementById('refreshAppBtn');
        
        if (refreshBtn) {
          const refreshIcon = refreshBtn.querySelector('span:first-child');
          
          // تغيير نص الزر وإضافة تأثير الدوران للرمز
          if (refreshIcon) {
            refreshIcon.style.animation = 'spin 1s linear infinite';
            const textSpan = refreshBtn.querySelector('span:last-child');
            if (textSpan) {
              textSpan.textContent = 'جاري إعادة التحميل...';
            }
          } else {
            refreshBtn.innerHTML = '⏳ جاري إعادة التحميل...';
          }
          
          refreshBtn.disabled = true;
        }
        
        // إظهار رسالة تحديث
        showTemporaryAlert('جاري إعادة تحميل التطبيق...', 'info');
        
        // انتظار قصير لإظهار الرسالة ثم إعادة تحميل الصفحة
        setTimeout(() => {
          window.location.reload(true);
        }, 1000);
        
      } catch (error) {
        console.error('Error refreshing app:', error);
        
        // إعادة زر التحديث لحالته الأصلية
        const refreshBtn = document.getElementById('refreshAppBtn');
        if (refreshBtn) {
          refreshBtn.innerHTML = '<span style="display: inline-block; transform-origin: center; transition: transform 0.3s;">🔄</span><span>تحديث</span>';
          refreshBtn.disabled = false;
        }
        
        // إظهار رسالة خطأ
        showTemporaryAlert('حدث خطأ أثناء إعادة تحميل التطبيق', 'error');
      }
    }

    window.refreshApp = refreshApp;
    
    // Expose account settings functions to window
    window.showAccountSettingsModal = showAccountSettingsModal;
    window.closeAccountSettingsModal = closeAccountSettingsModal;
    window.closeLevelsSettingsModal = closeLevelsSettingsModal;
    window.filterArchive = filterArchive;
    window.filterArchiveByAction = filterArchiveByAction;
    window.closeArchiveModal = closeArchiveModal;

    // Manual create first admin function (for console access)
    async function createFirstAdmin() {
      try {
        // Check if any admin exists
        const adminQuery = await usersCollection.where('isAdmin', '==', true).get();
        if (!adminQuery.empty) {
          alert('يوجد مدير بالفعل في النظام');
          return;
        }
        
        const email = prompt('أدخل بريد المدير الإلكتروني:');
        const password = prompt('أدخل كلمة مرور المدير:');
        const name = prompt('أدخل اسم المدير:');
        const phone = prompt('أدخل رقم هاتف المدير:');
        
        if (!email || !password || !name || !phone) {
          alert('يجب ملء جميع البيانات');
          return;
        }
        
        const userCredential = await auth.createUserWithEmailAndPassword(email, password);
        const user = userCredential.user;
        
        await user.updateProfile({ displayName: name });
        
        await usersCollection.doc(user.uid).set({
          name: name,
          email: email,
          phone: phone || '',
          isAdmin: true,
          isActive: true,
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        
        alert('تم إنشاء حساب المدير الأول بنجاح!');
      } catch (error) {
        alert('خطأ في إنشاء حساب المدير: ' + error.message);
      }
    }
    
    // Expose function globally for console access
    window.createFirstAdmin = createFirstAdmin;

    // Book Exchange Feature
    let currentExchangeLevel = null;
    let editingExchangeId = null;
    
    // Initialize global variables
    window.exchangeStats = {
      total: 0,
      offers: 0,
      requests: 0,
      byLevel: {}
    };
    
    // إحصائيات عامة لعدد العروض والطلبات من المستخدمين الآخرين
    window.allOffers = 0;
    window.allRequests = 0;
    
    // دالة لحساب عدد العروض والطلبات من المستخدمين الآخرين
    async function countExchangeStats() {
      if (!currentUser) return;
      
      try {
        // إعادة تعيين العدادات
        window.allOffers = 0;
        window.allRequests = 0;
        
        // الحصول على جميع الإعلانات
        const snapshot = await exchangeCollection.get();
        
        // حساب عدد العروض والطلبات
        snapshot.forEach(doc => {
          const data = doc.data();
          
          // حساب فقط إعلانات المستخدمين الآخرين
          if (data.userId !== currentUser.uid) {
            if (data.type === 'offer') {
              window.allOffers++;
            } else if (data.type === 'request') {
              window.allRequests++;
            }
          }
        });
        
        // تحديث عدادات التبويبات
        updateTabCounts();
        
        // تم إزالة رسالة التصحيح من الكونسول
      } catch (error) {
        console.error('Error counting exchange stats:', error);
      }
    }
    
    // وظيفة للتحقق من العروض والطلبات المنتهية وحذفها
    async function checkExpiredExchanges() {
      try {
        const now = new Date();
        
        // جلب جميع العروض والطلبات التي انتهت صلاحيتها
        const snapshot = await exchangeCollection.where('expiryDate', '<=', now).get();
        
        if (snapshot.empty) {
          // تم إزالة رسالة التصحيح من الكونسول
          return;
        }
        
        // تم إزالة رسالة التصحيح من الكونسول
        
        // إنشاء مصفوفة من الوعود لحذف العناصر المنتهية
        const deletePromises = [];
        const notificationPromises = [];
        
        snapshot.forEach(doc => {
          const exchange = doc.data();
          
          // إضافة وعد لحذف العنصر
          deletePromises.push(exchangeCollection.doc(doc.id).delete());
          
          // إرسال إشعار للمستخدم (إذا كان متصلاً)
          if (currentUser && exchange.userId === currentUser.uid) {
            const typeText = exchange.type === 'offer' ? 'عرض' : 'طلب';
            showTemporaryAlert(`تم حذف ${typeText} الكتاب "${exchange.bookName}" تلقائياً لانتهاء صلاحيته. يمكنك إعادة نشره من جديد إذا كنت لا تزال مهتماً.`, 'info', 8000);
          }
        });
        
        // انتظار اكتمال جميع عمليات الحذف
        await Promise.all(deletePromises);
        
        // إعادة تحميل القائمة بعد الحذف
        if (currentUser) {
          loadExchangeListings(currentExchangeType);
        }
        
      } catch (error) {
        console.error('Error checking expired exchanges:', error);
      }
      
      // التحقق من العروض والطلبات التي ستنتهي قريباً
      checkSoonToExpireExchanges();
    }
    
    // وظيفة للتحقق من العروض والطلبات التي ستنتهي قريباً وإرسال إشعارات
    async function checkSoonToExpireExchanges() {
      if (!currentUser) return;
      
      try {
        const now = new Date();
        const oneWeekLater = new Date();
        oneWeekLater.setDate(now.getDate() + 7); // أسبوع من الآن
        
        // جلب العروض والطلبات التي ستنتهي خلال أسبوع وتخص المستخدم الحالي
        const snapshot = await exchangeCollection
          .where('userId', '==', currentUser.uid)
          .where('expiryDate', '>', now)
          .where('expiryDate', '<=', oneWeekLater)
          .get();
        
        if (snapshot.empty) {
          return;
        }
        
        // تم إزالة رسالة التصحيح من الكونسول
        
        snapshot.forEach(doc => {
          const exchange = doc.data();
          const typeText = exchange.type === 'offer' ? 'عرض' : 'طلب';
          const expiryDate = exchange.expiryDate.toDate();
          const expiryDateFormatted = `${expiryDate.getDate()}/${expiryDate.getMonth() + 1}/${expiryDate.getFullYear()}`;
          
          // حساب عدد الأيام المتبقية
          const daysLeft = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));
          
          // إرسال إشعار للمستخدم
          showTemporaryAlert(`تنبيه: ${typeText} الكتاب "${exchange.bookName}" سينتهي بعد ${daysLeft} أيام (${expiryDateFormatted}). إذا كنت لا تزال مهتماً، يمكنك إعادة نشره بعد انتهاء صلاحيته.`, 'warning', 10000);
        });
        
      } catch (error) {
        console.error('Error checking soon to expire exchanges:', error);
      }
    }
    
    // Show exchange form modal
    function showExchangeForm(type, exchangeId = null) {
      if (!currentUser) {
        alert('يجب تسجيل الدخول أولاً لإضافة عرض أو طلب');
        return;
      }
      
      // إذا كان تعديل لإعلان موجود، تحقق من الصلاحيات
      if (exchangeId && !isAdmin) {
        // تحقق من أن المستخدم هو صاحب الإعلان
        exchangeCollection.doc(exchangeId).get().then(doc => {
          if (doc.exists) {
            const data = doc.data();
            if (data.userId !== currentUser.uid) {
              showTemporaryAlert('ليس لديك صلاحية لتعديل هذا الإعلان', 'error');
              return;
            } else {
              // المستخدم هو صاحب الإعلان، استمر في العملية
              continueShowExchangeForm(type, exchangeId);
            }
          } else {
            showTemporaryAlert('الإعلان غير موجود أو تم حذفه', 'error');
          }
        }).catch(error => {
          console.error('Error checking exchange ownership:', error);
          showTemporaryAlert('حدث خطأ في التحقق من صلاحية التعديل', 'error');
        });
      } else {
        // إذا كان المستخدم مدير أو إضافة إعلان جديد، استمر مباشرة
        continueShowExchangeForm(type, exchangeId);
      }
    }
    
    // استمرار عرض نموذج الإعلان بعد التحقق من الصلاحيات
    function continueShowExchangeForm(type, exchangeId = null) {
      const modal = document.getElementById('exchangeModal');
      const title = document.getElementById('exchangeModalTitle');
      const countLabelNew = document.getElementById('exchangeCountLabelNew');
      const countLabelExisting = document.getElementById('exchangeCountLabelExisting');
      
      // إعادة تعيين النماذج
      document.getElementById('exchangeFormNew').reset();
      document.getElementById('exchangeFormExisting').reset();
      
      // إخفاء النماذج وإظهار خيارات الإضافة
      document.getElementById('exchangeFormNew').style.display = 'none';
      document.getElementById('exchangeFormExisting').style.display = 'none';
      document.getElementById('exchangeOptions').style.display = 'block';
      
      // تعيين نوع النموذج والعنوان
      if (type === 'offer') {
        title.textContent = 'عرض كتاب';
        countLabelNew.textContent = 'عدد الكتب المتاحة';
        countLabelExisting.textContent = 'عدد الكتب المتاحة';
      } else {
        title.textContent = 'طلب كتاب';
        countLabelNew.textContent = 'عدد الكتب المطلوبة';
        countLabelExisting.textContent = 'عدد الكتب المطلوبة';
      }
      
      // إضافة إشارة للمدير إذا كان يعدل إعلان مستخدم آخر
      if (exchangeId && isAdmin) {
        exchangeCollection.doc(exchangeId).get().then(doc => {
          if (doc.exists) {
            const data = doc.data();
            if (data.userId !== currentUser.uid) {
              // إضافة إشارة للمدير
              title.textContent += ' (تعديل بصلاحية المدير)';
            }
          }
        }).catch(error => {
          console.error('Error checking exchange ownership for admin:', error);
        });
      }
      
      // ملء قائمة المستويات الدراسية
      fillLevelOptions();
      
      // إذا كان تعديل لإعلان موجود
      if (exchangeId) {
        editingExchangeId = exchangeId;
        
        // جلب بيانات الإعلان وملء النموذج
        exchangeCollection.doc(exchangeId).get().then(doc => {
          if (doc.exists) {
            const data = doc.data();
            
            // عرض نموذج الكتاب الجديد مباشرة
            showExchangeOption('new');
            
            document.getElementById('exchangeBookName').value = data.bookName;
            document.getElementById('exchangeBookCountNew').value = data.count;
            
            // إذا كان هناك مستوى محفوظ، اختره
            if (data.bookLevel) {
              document.getElementById('exchangeBookLevel').value = data.bookLevel;
            }
          }
        }).catch(error => {
          console.error('Error fetching exchange:', error);
          showTemporaryAlert('حدث خطأ في تحميل البيانات', 'error');
        });
      } else {
        editingExchangeId = null;
      }
      
      // تعيين معالجات تقديم النماذج
      document.getElementById('exchangeFormNew').onsubmit = function(e) {
        e.preventDefault();
        submitExchangeFormNew(type);
      };
      
      document.getElementById('exchangeFormExisting').onsubmit = function(e) {
        e.preventDefault();
        submitExchangeFormExisting(type);
      };
      
      // عرض النافذة المنبثقة
      modal.style.display = 'flex';
    }
    
    // إظهار الخيار المحدد (كتاب جديد أو كتاب موجود)
    function showExchangeOption(option) {
      // إخفاء خيارات الإضافة
      document.getElementById('exchangeOptions').style.display = 'none';
      
      if (option === 'new') {
        // إظهار نموذج الكتاب الجديد
        document.getElementById('exchangeFormNew').style.display = 'block';
        document.getElementById('exchangeFormExisting').style.display = 'none';
      } else {
        // إظهار نموذج اختيار كتاب موجود
        document.getElementById('exchangeFormNew').style.display = 'none';
        document.getElementById('exchangeFormExisting').style.display = 'block';
      }
    }
    
    // ملء قوائم المستويات الدراسية
    function fillLevelOptions() {
      const levelSelectNew = document.getElementById('exchangeBookLevel');
      const levelSelectExisting = document.getElementById('exchangeExistingLevel');
      
      // مسح الخيارات الحالية
      levelSelectNew.innerHTML = '<option value="">-- اختر المستوى --</option>';
      levelSelectExisting.innerHTML = '<option value="">-- اختر المستوى --</option>';
      
      // إضافة المستويات من متغير levels
      levels.forEach(level => {
        const optionNew = document.createElement('option');
        optionNew.value = level.name;
        optionNew.textContent = level.name;
        levelSelectNew.appendChild(optionNew);
        
        const optionExisting = document.createElement('option');
        optionExisting.value = level.name;
        optionExisting.textContent = level.name;
        levelSelectExisting.appendChild(optionExisting);
      });
    }
    
    // تحميل الكتب الموجودة بناءً على المستوى المختار
    function loadExistingBooks() {
      const levelSelect = document.getElementById('exchangeExistingLevel');
      const bookSelect = document.getElementById('exchangeExistingBook');
      const selectedLevel = levelSelect.value;
      
      // مسح قائمة الكتب
      bookSelect.innerHTML = '<option value="">-- اختر الكتاب --</option>';
      
      if (!selectedLevel) return;
      
      // البحث عن المستوى المختار
      const level = levels.find(l => l.name === selectedLevel);
      if (!level || !level.books || level.books.length === 0) {
        bookSelect.innerHTML = '<option value="">لا توجد كتب في هذا المستوى</option>';
        return;
      }
      
      // إضافة الكتب للقائمة
      level.books.forEach(book => {
        const option = document.createElement('option');
        option.value = book;
        option.textContent = book;
        bookSelect.appendChild(option);
      });
    }
    
    // إغلاق نافذة تبادل الكتب
    function closeExchangeModal() {
      document.getElementById('exchangeModal').style.display = 'none';
      editingExchangeId = null;
    }
    
    // تقديم نموذج إضافة كتاب جديد
    async function submitExchangeFormNew(type) {
      if (!currentUser) {
        alert('يجب تسجيل الدخول أولاً لإضافة عرض أو طلب');
        closeExchangeModal();
        return;
      }
      
      const bookName = document.getElementById('exchangeBookName').value.trim();
      const bookLevel = document.getElementById('exchangeBookLevel').value;
      const count = parseInt(document.getElementById('exchangeBookCountNew').value);
      const imageFile = document.getElementById('exchangeBookImage').files[0];
      
      if (!bookName || !bookLevel || count < 1) {
        alert('يرجى ملء جميع الحقول بشكل صحيح');
        return;
      }
      
      try {
        // حساب تاريخ انتهاء الصلاحية (بعد شهرين)
        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + 60); // 60 يوم (شهرين)
        
        let bookImageUrl = null;
        
        // رفع الصورة إذا تم اختيارها
        if (imageFile) {
          const imageRef = storage.ref(`book-images/${Date.now()}_${imageFile.name}`);
          const uploadTask = await imageRef.put(imageFile);
          bookImageUrl = await uploadTask.ref.getDownloadURL();
        }
        
        const exchangeData = {
          userId: currentUser.uid,
          userName: currentUser.name || currentUser.displayName || 'مستخدم',
          userEmail: currentUser.email,
          userPhone: currentUser.phone || 'غير متوفر',
          bookName: bookName,
          bookLevel: bookLevel,
          count: count,
          type: type, // 'offer' or 'request'
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          expiryDate: expiryDate,
          bookImageUrl: bookImageUrl
        };
        
        // تنسيق تاريخ انتهاء الصلاحية للعرض
        const expiryDateFormatted = `${expiryDate.getDate()}/${expiryDate.getMonth() + 1}/${expiryDate.getFullYear()}`;
        const typeText = type === 'offer' ? 'عرض' : 'طلب';
        
        // إذا كان تعديل لإعلان موجود
        if (editingExchangeId) {
          // جلب بيانات الإعلان للتحقق من الملكية
          const exchangeDoc = await exchangeCollection.doc(editingExchangeId).get();
          if (!exchangeDoc.exists) {
            showTemporaryAlert('الإعلان غير موجود أو تم حذفه بالفعل', 'error');
            return;
          }
          
          const exchangeDocData = exchangeDoc.data();
          const isOwner = exchangeDocData.userId === currentUser.uid;
          
          // التحقق من الصلاحيات - يسمح فقط للمالك أو المدير
          if (!isOwner && !isAdmin) {
            showTemporaryAlert('ليس لديك صلاحية لتعديل هذا الإعلان', 'error');
            return;
          }
          
          // تحديث الإعلان
          const updateData = {
            bookName: bookName,
            bookLevel: bookLevel,
            count: count,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
            expiryDate: expiryDate
          };
          
          // إضافة رابط الصورة إذا تم رفع صورة جديدة
          if (bookImageUrl) {
            updateData.bookImageUrl = bookImageUrl;
          }
          
          await exchangeCollection.doc(editingExchangeId).update(updateData);
          
          // رسالة نجاح مخصصة
          if (isAdmin && !isOwner) {
            showTemporaryAlert(`تم تحديث ${typeText} الكتاب بنجاح (بصلاحية المدير). سيبقى متاحاً في القوائم حتى تاريخ ${expiryDateFormatted}، بعدها سيتم حذفه تلقائياً.`, 'success', 8000);
          } else {
            showTemporaryAlert(`تم تحديث ${typeText} الكتاب بنجاح. سيبقى متاحاً في القوائم حتى تاريخ ${expiryDateFormatted}، بعدها سيتم حذفه تلقائياً.`, 'success', 8000);
          }
        } else {
          // إنشاء إعلان جديد
          const exchangeDoc = await exchangeCollection.add(exchangeData);
          const newExchangeId = exchangeDoc.id;
          
          // إضافة معرف الإعلان إلى بيانات الإشعار
          const exchangeDataWithId = { ...exchangeData, exchangeId: newExchangeId };
          
          // إنشاء إشعار للمستخدمين الآخرين (فقط للإعلانات الجديدة)
          await notifyNewExchange(exchangeDataWithId);
          
          // لا نضيف الكتاب إلى قائمة المستوى - الإعلانات منفصلة عن قوائم الكتب الرسمية
          
          showTemporaryAlert(`تم إضافة ${typeText} الكتاب بنجاح. سيبقى متاحاً حتى تاريخ ${expiryDateFormatted}`, 'success', 8000);
        }
        
        closeExchangeModal();
        
        // تحديث الإحصائيات
        await countExchangeStats();
        loadExchangeListings(currentExchangeType);
      } catch (error) {
        console.error('Error submitting exchange:', error);
        showTemporaryAlert('حدث خطأ في حفظ البيانات', 'error');
      }
    }
    
    // تقديم نموذج اختيار كتاب موجود
    async function submitExchangeFormExisting(type) {
      if (!currentUser) {
        alert('يجب تسجيل الدخول أولاً لإضافة عرض أو طلب');
        closeExchangeModal();
        return;
      }
      
      const levelSelect = document.getElementById('exchangeExistingLevel');
      const bookSelect = document.getElementById('exchangeExistingBook');
      const count = parseInt(document.getElementById('exchangeBookCountExisting').value);
      
      const bookLevel = levelSelect.value;
      const bookName = bookSelect.value;
      
      if (!bookLevel || !bookName || count < 1) {
        alert('يرجى ملء جميع الحقول بشكل صحيح');
        return;
      }
      
      try {
        // حساب تاريخ انتهاء الصلاحية (بعد شهرين)
        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + 60); // 60 يوم (شهرين)
        
        // البحث عن صورة الكتاب في بيانات المستوى
        let bookImageUrl = null;
        if (bookLevel && bookName) {
          const level = levels.find(l => l.name === bookLevel);
          if (level) {
            // البحث في bookImages أولاً
            if (level.bookImages && level.bookImages[bookName]) {
              bookImageUrl = level.bookImages[bookName];
            }
            // إذا لم توجد، ابحث في booksWithImages
            else if (level.booksWithImages && level.booksWithImages[bookName]) {
              bookImageUrl = level.booksWithImages[bookName];
            }
          }
        }

        const exchangeData = {
          userId: currentUser.uid,
          userName: currentUser.name || currentUser.displayName || 'مستخدم',
          userEmail: currentUser.email,
          userPhone: currentUser.phone || 'غير متوفر',
          bookName: bookName,
          bookLevel: bookLevel,
          count: count,
          type: type, // 'offer' or 'request'
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          expiryDate: expiryDate,
          bookImageUrl: bookImageUrl
        };
        
        // تنسيق تاريخ انتهاء الصلاحية للعرض
        const expiryDateFormatted = `${expiryDate.getDate()}/${expiryDate.getMonth() + 1}/${expiryDate.getFullYear()}`;
        const typeText = type === 'offer' ? 'عرض' : 'طلب';
        
        // إذا كان تعديل لإعلان موجود
        if (editingExchangeId) {
          // جلب بيانات الإعلان للتحقق من الملكية
          const exchangeDoc = await exchangeCollection.doc(editingExchangeId).get();
          if (!exchangeDoc.exists) {
            showTemporaryAlert('الإعلان غير موجود أو تم حذفه بالفعل', 'error');
            return;
          }
          
          const exchangeDocData = exchangeDoc.data();
          const isOwner = exchangeDocData.userId === currentUser.uid;
          
          // التحقق من الصلاحيات - يسمح فقط للمالك أو المدير
          if (!isOwner && !isAdmin) {
            showTemporaryAlert('ليس لديك صلاحية لتعديل هذا الإعلان', 'error');
            return;
          }
          
          // تحديث الإعلان
          const updateData = {
            bookName: bookName,
            bookLevel: bookLevel,
            count: count,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
            expiryDate: expiryDate
          };
          
          // إضافة رابط الصورة إذا كان متوفراً
          if (bookImageUrl) {
            updateData.bookImageUrl = bookImageUrl;
          }
          
          await exchangeCollection.doc(editingExchangeId).update(updateData);
          
          // رسالة نجاح مخصصة
          if (isAdmin && !isOwner) {
            showTemporaryAlert(`تم تحديث ${typeText} الكتاب بنجاح (بصلاحية المدير). سيبقى متاحاً حتى تاريخ ${expiryDateFormatted}.`, 'success', 8000);
          } else {
            showTemporaryAlert(`تم تحديث ${typeText} الكتاب بنجاح. سيبقى متاحاً حتى تاريخ ${expiryDateFormatted}.`, 'success', 8000);
          }
        } else {
          // إنشاء إعلان جديد
          const exchangeDoc = await exchangeCollection.add(exchangeData);
          const newExchangeId = exchangeDoc.id;
          
          // إضافة معرف الإعلان إلى بيانات الإشعار
          const exchangeDataWithId = { ...exchangeData, exchangeId: newExchangeId };
          
          // إنشاء إشعار للمستخدمين الآخرين (فقط للإعلانات الجديدة)
          await notifyNewExchange(exchangeDataWithId);
          
          // لا نضيف الكتاب إلى قائمة المستوى - الإعلانات منفصلة عن قوائم الكتب الرسمية
          
          showTemporaryAlert(`تم إضافة ${typeText} الكتاب بنجاح. سيبقى متاحاً حتى تاريخ ${expiryDateFormatted}`, 'success', 8000);
        }
        
        closeExchangeModal();
        
        // تحديث الإحصائيات
        await countExchangeStats();
        loadExchangeListings(currentExchangeType);
      } catch (error) {
        console.error('Error submitting exchange:', error);
        showTemporaryAlert('حدث خطأ في حفظ البيانات', 'error');
      }
    }
    
    // Delete exchange and its associated image
    async function deleteExchange(exchangeId) {
      if (!currentUser) {
        alert('يجب تسجيل الدخول أولاً لحذف الإعلان');
        return;
      }
      
      try {
        // جلب بيانات الإعلان للتحقق من الملكية
        const exchangeDoc = await exchangeCollection.doc(exchangeId).get();
        if (!exchangeDoc.exists) {
          showTemporaryAlert('الإعلان غير موجود أو تم حذفه بالفعل', 'error');
          return;
        }
        
        const exchangeData = exchangeDoc.data();
        
        // حذف صورة الإعلان إذا كانت موجودة ولا تنتمي لقائمة الكتب الرسمية
        if (exchangeData.bookImageUrl && !isImageInOfficialBooks(exchangeData.bookName, exchangeData.bookLevel, exchangeData.bookImageUrl)) {
          try {
            const imageRef = firebase.storage().refFromURL(exchangeData.bookImageUrl);
            await imageRef.delete();
          } catch (imageError) {
            console.log('تعذر حذف الصورة أو أنها محذوفة بالفعل:', imageError);
          }
        }
        const isOwner = exchangeData.userId === currentUser.uid;
        
        // التحقق من الصلاحيات - يسمح فقط للمالك أو المدير
        if (!isOwner && !isAdmin) {
          showTemporaryAlert('ليس لديك صلاحية لحذف هذا الإعلان', 'error');
          return;
        }
        
        // تأكيد الحذف مع رسالة مخصصة للمدير
        let confirmMessage = 'هل أنت متأكد من حذف هذا الإعلان؟';
        if (isAdmin && !isOwner) {
          confirmMessage = 'أنت على وشك حذف إعلان مستخدم آخر بصلاحية المدير. هل أنت متأكد؟';
        }
        
        if (confirm(confirmMessage)) {
          await exchangeCollection.doc(exchangeId).delete();
          
          // حذف جميع الإشعارات المرتبطة بهذا الإعلان
          await deleteRelatedNotifications(exchangeId);
          
          // رسالة نجاح مخصصة
          if (isAdmin && !isOwner) {
            showTemporaryAlert('تم حذف الإعلان بنجاح (بصلاحية المدير)', 'success');
          } else {
            showTemporaryAlert('تم حذف الإعلان بنجاح', 'success');
          }
          
          // تحديث الإحصائيات
          await countExchangeStats();
          loadExchangeListings(currentExchangeType);
        }
      } catch (error) {
        console.error('Error deleting exchange:', error);
        showTemporaryAlert('حدث خطأ في حذف الإعلان', 'error');
      }
    }
    
    // Initialize exchange search functionality
    function initializeExchangeSearch() {
      // Populate level select dropdown
      const levelSelect = document.getElementById('exchangeLevelSelect');
      if (levelSelect) {
        levelSelect.innerHTML = '<option value="">جميع المستويات</option>';
        levels.forEach(level => {
          const option = document.createElement('option');
          option.value = level.name;
          option.textContent = level.name;
          levelSelect.appendChild(option);
        });
      }
      
      // Show search section for offers and requests tabs
      const searchSection = document.getElementById('exchangeSearchSection');
      if (currentExchangeType === 'offers' || currentExchangeType === 'requests') {
        searchSection.style.display = 'block';
      } else {
        searchSection.style.display = 'none';
      }
      
      // Add enter key listener to search input
      const searchInput = document.getElementById('exchangeSearchInput');
      if (searchInput) {
        searchInput.addEventListener('keypress', function(e) {
          if (e.key === 'Enter') {
            performExchangeSearch();
          }
        });
        
        // Add real-time search suggestions
        searchInput.addEventListener('input', function() {
          if (this.value.length >= 2) {
            showSearchSuggestions(this.value);
          } else {
            clearSearchSuggestions();
          }
        });
      }
    }
    
    // مسح البحث والعودة للحالة الأصلية
    function clearExchangeSearch() {
      // مسح حقل البحث وقائمة المستويات
      const searchInput = document.getElementById('exchangeSearchInput');
      const levelSelect = document.getElementById('exchangeLevelSelect');
      const resultsDiv = document.getElementById('exchangeSearchResults');
      const suggestionsDiv = document.getElementById('exchangeSearchSuggestions');
      
      if (searchInput) searchInput.value = '';
      if (levelSelect) levelSelect.value = '';
      if (resultsDiv) resultsDiv.innerHTML = '';
      if (suggestionsDiv) suggestionsDiv.innerHTML = '';
      
      // إعادة تحميل قوائم التبادل الأصلية
      loadExchangeListings(currentExchangeType);
      
      // عرض رسالة نجاح
      showTemporaryAlert('تم مسح البحث بنجاح', 'success', 2000);
    }
    
    // Perform intelligent book search in user exchanges
    async function performExchangeSearch() {
      const searchInput = document.getElementById('exchangeSearchInput');
      const levelSelect = document.getElementById('exchangeLevelSelect');
      const resultsDiv = document.getElementById('exchangeSearchResults');
      const suggestionsDiv = document.getElementById('exchangeSearchSuggestions');
      
      if (!searchInput || !levelSelect || !resultsDiv) return;
      
      const searchTerm = searchInput.value.trim();
      const selectedLevel = levelSelect.value;
      
      if (!searchTerm) {
        resultsDiv.innerHTML = '<div style="color: #e53e3e; text-align: center; padding: 20px;">يرجى إدخال اسم الكتاب للبحث</div>';
        return;
      }
      
      resultsDiv.innerHTML = '<div style="text-align: center; padding: 20px;">جاري البحث...</div>';
      suggestionsDiv.innerHTML = '';
      
      try {
        // Search in actual user exchanges
        const searchResults = await searchInUserExchanges(searchTerm, selectedLevel);
        
        if (searchResults.exactMatches.length > 0 || searchResults.fuzzyMatches.length > 0) {
          displayExchangeSearchResults(searchResults, searchTerm);
        } else {
          // Show suggestions from available exchanges
          const suggestions = await generateExchangeSuggestions(searchTerm, selectedLevel);
          displayNoExchangeResultsWithSuggestions(searchTerm, suggestions);
        }
      } catch (error) {
        console.error('Error searching exchanges:', error);
        resultsDiv.innerHTML = '<div style="color: #e53e3e; text-align: center; padding: 20px;">حدث خطأ أثناء البحث</div>';
      }
    }
    
    // Search in actual user exchanges (offers and requests)
    async function searchInUserExchanges(searchTerm, selectedLevel) {
      const results = {
        exactMatches: [],
        fuzzyMatches: []
      };
      
      const normalizedSearch = normalizeArabicText(searchTerm.toLowerCase());
      
      try {
        // Get current exchange type to determine what to search
        const searchType = currentExchangeType === 'offers' ? 'offer' : 'request';
        
        // Query exchanges from other users
        let query = exchangeCollection.where('type', '==', searchType);
        
        const snapshot = await query.get();
        
        snapshot.forEach(doc => {
          const data = doc.data();
          
          // Skip current user's exchanges
          if (data.userId === currentUser.uid) return;
          
          // Filter by level if selected
          if (selectedLevel && data.bookLevel !== selectedLevel) return;
          
          const normalizedBookName = normalizeArabicText(data.bookName.toLowerCase());
          
          // Exact match
          if (normalizedBookName === normalizedSearch || normalizedBookName.includes(normalizedSearch)) {
            results.exactMatches.push({
              id: doc.id,
              book: data.bookName,
              level: data.bookLevel,
              count: data.count,
              userName: data.userName,
              userPhone: data.userPhone,
              type: data.type,
              createdAt: data.createdAt,
              matchType: 'exact'
            });
          }
          // Fuzzy match
          else if (calculateSimilarity(normalizedSearch, normalizedBookName) > 0.6) {
            results.fuzzyMatches.push({
              id: doc.id,
              book: data.bookName,
              level: data.bookLevel,
              count: data.count,
              userName: data.userName,
              userPhone: data.userPhone,
              type: data.type,
              createdAt: data.createdAt,
              matchType: 'fuzzy',
              similarity: calculateSimilarity(normalizedSearch, normalizedBookName)
            });
          }
        });
        
        // Sort fuzzy matches by similarity
        results.fuzzyMatches.sort((a, b) => b.similarity - a.similarity);
        
      } catch (error) {
        console.error('Error searching in exchanges:', error);
      }
      
      return results;
    }
    
    // Generate intelligent suggestions from available exchanges
    async function generateExchangeSuggestions(searchTerm, selectedLevel) {
      const suggestions = [];
      const normalizedSearch = normalizeArabicText(searchTerm.toLowerCase());
      
      try {
        const searchType = currentExchangeType === 'offers' ? 'offer' : 'request';
        let query = exchangeCollection.where('type', '==', searchType);
        
        const snapshot = await query.get();
        
        snapshot.forEach(doc => {
          const data = doc.data();
          
          // Skip current user's exchanges
          if (data.userId === currentUser.uid) return;
          
          // Filter by level if selected
          if (selectedLevel && data.bookLevel !== selectedLevel) return;
          
          const normalizedBookName = normalizeArabicText(data.bookName.toLowerCase());
          const similarity = calculateSimilarity(normalizedSearch, normalizedBookName);
          
          if (similarity > 0.3) {
            suggestions.push({
              book: data.bookName,
              level: data.bookLevel,
              similarity: similarity,
              count: data.count,
              userName: data.userName
            });
          }
        });
        
        // Remove duplicates and sort by similarity
        const uniqueSuggestions = suggestions.reduce((acc, current) => {
          const existing = acc.find(item => item.book === current.book && item.level === current.level);
          if (!existing) {
            acc.push(current);
          }
          return acc;
        }, []);
        
        return uniqueSuggestions.sort((a, b) => b.similarity - a.similarity).slice(0, 8);
        
      } catch (error) {
        console.error('Error generating exchange suggestions:', error);
        return [];
      }
    }
    
    // Show real-time search suggestions from exchanges
    async function showSearchSuggestions(searchTerm) {
      const suggestionsDiv = document.getElementById('exchangeSearchSuggestions');
      if (!suggestionsDiv) return;
      
      try {
        const suggestions = await generateExchangeSuggestions(searchTerm, '');
        
        if (suggestions.length > 0) {
          let html = '<div class="search-suggestion-title">اقتراحات من الإعلانات المتاحة:</div>';
          html += '<div class="search-suggestions-list">';
          
          suggestions.slice(0, 5).forEach(suggestion => {
            html += `<button class="search-suggestion-item" onclick="selectSuggestion('${suggestion.book}', '${suggestion.level}')">${suggestion.book}</button>`;
          });
          
          html += '</div>';
          suggestionsDiv.innerHTML = html;
        } else {
          suggestionsDiv.innerHTML = '';
        }
      } catch (error) {
        console.error('Error showing search suggestions:', error);
        suggestionsDiv.innerHTML = '';
      }
    }
    
    // Clear search suggestions
    function clearSearchSuggestions() {
      const suggestionsDiv = document.getElementById('exchangeSearchSuggestions');
      if (suggestionsDiv) {
        suggestionsDiv.innerHTML = '';
      }
    }
    
    // Select a suggestion
    function selectSuggestion(bookName, levelName) {
      const searchInput = document.getElementById('exchangeSearchInput');
      const levelSelect = document.getElementById('exchangeLevelSelect');
      
      if (searchInput) searchInput.value = bookName;
      if (levelSelect) levelSelect.value = levelName;
      
      clearSearchSuggestions();
      performExchangeSearch();
    }
    
    // Display exchange search results with user information
    function displayExchangeSearchResults(results, searchTerm) {
      const resultsDiv = document.getElementById('exchangeSearchResults');
      let html = '';
      
      if (results.exactMatches.length > 0) {
        html += '<div style="margin-bottom: 20px;">';
        html += '<h4 style="color: #38a169; margin-bottom: 15px;">✅ نتائج مطابقة تماماً:</h4>';
        
        results.exactMatches.forEach(result => {
          const typeText = result.type === 'offer' ? 'معروض للبيع' : 'مطلوب للشراء';
          const typeIcon = result.type === 'offer' ? '📚' : '🔍';
          const createdDate = result.createdAt ? (() => {
            const date = new Date(result.createdAt.seconds * 1000);
            return `${date.getDate()}/${date.getMonth() + 1}/${date.getFullYear()}`;
          })() : 'غير محدد';
          
          html += `
            <div class="search-result-item">
              <div class="search-result-book">${result.book}</div>
              <div class="search-result-level">📚 ${result.level}</div>
              <div style="margin: 8px 0; color: #4a5568;">
                <span style="margin-left: 15px;">${typeIcon} ${typeText}</span>
                <span style="margin-left: 15px;">📊 العدد: ${result.count}</span>
              </div>
              <div style="margin: 8px 0; color: #667eea; font-size: 0.9em;">
                <span style="margin-left: 15px;">👤 ${result.userName}</span>
                <span style="margin-left: 15px;">📞 ${result.userPhone}</span>
              </div>
              <div style="margin: 8px 0; color: #718096; font-size: 0.8em;">تاريخ النشر: ${createdDate}</div>
              <div class="search-result-match">مطابقة تامة</div>
            </div>
          `;
        });
        html += '</div>';
      }
      
      if (results.fuzzyMatches.length > 0) {
        html += '<div>';
        html += '<h4 style="color: #d69e2e; margin-bottom: 15px;">💡 نتائج مشابهة:</h4>';
        
        results.fuzzyMatches.forEach(result => {
          const matchPercentage = Math.round(result.similarity * 100);
          const typeText = result.type === 'offer' ? 'معروض للبيع' : 'مطلوب للشراء';
          const typeIcon = result.type === 'offer' ? '📚' : '🔍';
          const createdDate = result.createdAt ? (() => {
            const date = new Date(result.createdAt.seconds * 1000);
            return `${date.getDate()}/${date.getMonth() + 1}/${date.getFullYear()}`;
          })() : 'غير محدد';
          
          html += `
            <div class="search-result-item">
              <div class="search-result-book">${result.book}</div>
              <div class="search-result-level">📚 ${result.level}</div>
              <div style="margin: 8px 0; color: #4a5568;">
                <span style="margin-left: 15px;">${typeIcon} ${typeText}</span>
                <span style="margin-left: 15px;">📊 العدد: ${result.count}</span>
              </div>
              <div style="margin: 8px 0; color: #667eea; font-size: 0.9em;">
                <span style="margin-left: 15px;">👤 ${result.userName}</span>
                <span style="margin-left: 15px;">📞 ${result.userPhone}</span>
              </div>
              <div style="margin: 8px 0; color: #718096; font-size: 0.8em;">تاريخ النشر: ${createdDate}</div>
              <div class="search-result-match">تشابه ${matchPercentage}%</div>
            </div>
          `;
        });
        html += '</div>';
      }
      
      resultsDiv.innerHTML = html;
    }
    
    // Display no exchange results with suggestions
    function displayNoExchangeResultsWithSuggestions(searchTerm, suggestions) {
      const resultsDiv = document.getElementById('exchangeSearchResults');
      const currentTypeText = currentExchangeType === 'offers' ? 'المعروضة للبيع' : 'المطلوبة للشراء';
      
      let html = `
        <div style="text-align: center; padding: 20px; color: #4a5568;">
          <div style="font-size: 1.2em; margin-bottom: 15px;">❌ لم يتم العثور على "${searchTerm}" في الكتب ${currentTypeText}</div>
      `;
      
      if (suggestions.length > 0) {
        html += '<div style="margin-top: 20px;">';
        html += '<div class="search-suggestion-title">هل تقصد أحد هذه الكتب المتاحة؟</div>';
        html += '<div class="search-suggestions-list">';
        
        suggestions.forEach(suggestion => {
          html += `<button class="search-suggestion-item" onclick="selectSuggestion('${suggestion.book}', '${suggestion.level}')">${suggestion.book} (${suggestion.level})</button>`;
        });
        
        html += '</div></div>';
      } else {
        html += '<div style="margin-top: 15px; color: #718096;">لا توجد كتب مشابهة في الإعلانات الحالية. جرب البحث بكلمات أخرى أو تحقق من المستوى المحدد</div>';
      }
      
      html += '</div>';
      resultsDiv.innerHTML = html;
    }
    
    // Normalize Arabic text for better matching
    function normalizeArabicText(text) {
      return text
        .replace(/[أإآ]/g, 'ا')
        .replace(/[ة]/g, 'ه')
        .replace(/[ى]/g, 'ي')
        .replace(/[ء]/g, '')
        .replace(/[ًٌٍَُِّْ]/g, '')  // Remove diacritics
        .replace(/\s+/g, ' ')
        .trim();
    }
    
    // Calculate similarity between two strings using Levenshtein distance
    function calculateSimilarity(str1, str2) {
      const len1 = str1.length;
      const len2 = str2.length;
      
      if (len1 === 0) return len2 === 0 ? 1 : 0;
      if (len2 === 0) return 0;
      
      const matrix = Array(len1 + 1).fill().map(() => Array(len2 + 1).fill(0));
      
      for (let i = 0; i <= len1; i++) matrix[i][0] = i;
      for (let j = 0; j <= len2; j++) matrix[0][j] = j;
      
      for (let i = 1; i <= len1; i++) {
        for (let j = 1; j <= len2; j++) {
          const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
          matrix[i][j] = Math.min(
            matrix[i - 1][j] + 1,      // deletion
            matrix[i][j - 1] + 1,      // insertion
            matrix[i - 1][j - 1] + cost // substitution
          );
        }
      }
      
      const maxLen = Math.max(len1, len2);
      return (maxLen - matrix[len1][len2]) / maxLen;
    }

    // Switch between exchange tabs
    async function switchExchangeTab(tabType) {
      currentExchangeType = tabType;
      currentExchangeLevel = null; // إعادة تعيين المستوى المختار
      
      // إظهار/إخفاء حاوي الإجراءات المجمعة
      const bulkActionsContainer = document.getElementById('bulkActionsContainer');
      const adminBulkActionsContainer = document.getElementById('adminBulkActionsContainer');
      
      if (bulkActionsContainer) {
        if (tabType === 'my') {
          bulkActionsContainer.style.display = 'block';
        } else {
          bulkActionsContainer.style.display = 'none';
        }
      }
      
      if (adminBulkActionsContainer) {
        if (tabType !== 'my' && isAdmin) {
          adminBulkActionsContainer.style.display = 'block';
        } else {
          adminBulkActionsContainer.style.display = 'none';
        }
      }
      
      // تحديث التبويب النشط
      const tabs = document.querySelectorAll('.exchange-tab');
      tabs.forEach(tab => {
        tab.classList.remove('active');
        if (tab.textContent.includes('كتب معروضة') && tabType === 'offers') tab.classList.add('active');
        if (tab.textContent.includes('كتب مطلوبة') && tabType === 'requests') tab.classList.add('active');
        if (tab.textContent.includes('إعلاناتي') && tabType === 'my') tab.classList.add('active');
      });
      
      // إظهار أو إخفاء قسم تصفية المستويات
      const levelsFilterDiv = document.getElementById('exchangeLevelsFilter');
      if (tabType === 'my') {
        levelsFilterDiv.style.display = 'none';
      } else {
        levelsFilterDiv.style.display = 'block';
      }
      
      // Initialize search functionality
      initializeExchangeSearch();
      
      // تحديث الإحصائيات أولاً
      await countExchangeStats();
      
      // تحميل الإعلانات للتبويب المحدد
      loadExchangeListings(tabType);
    }
    
    // تبديل المستوى المحدد
    function switchExchangeLevel(level) {
      currentExchangeLevel = level === currentExchangeLevel ? null : level;
      
      // تحديث أزرار المستويات
      const levelButtons = document.querySelectorAll('.exchange-level-btn');
      levelButtons.forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.level === currentExchangeLevel) {
          btn.classList.add('active');
        }
      });
      
      // إعادة عرض الإعلانات مع التصفية حسب المستوى
      renderFilteredExchanges();
    }
    
    // تحميل إعلانات تبادل الكتب
    async function loadExchangeListings(tabType) {
      const listingsDiv = document.getElementById('exchangeListings');
      
      // التحقق من وجود عنصر العرض
      if (!listingsDiv) {
        // تم إزالة رسالة التصحيح من الكونسول
        return;
      }
      
      if (!currentUser) {
        listingsDiv.innerHTML = `
          <div class="exchange-empty">يجب تسجيل الدخول لعرض إعلانات تبادل الكتب</div>
        `;
        return;
      }
      
      listingsDiv.innerHTML = `<div class="exchange-empty">جاري التحميل...</div>`;
      
      try {
        // إلغاء الاستماع السابق إذا وجد
        if (window.currentExchangeListener) {
          window.currentExchangeListener();
          window.currentExchangeListener = null;
        }
        
        let query;
        
        // استخدام استعلامات منفصلة لتجنب الحاجة إلى فهارس مركبة
        if (tabType === 'offers') {
          // عرض عروض المستخدمين الآخرين فقط (بدون عروض المستخدم الحالي)
          query = exchangeCollection
            .where('type', '==', 'offer');
        } else if (tabType === 'requests') {
          // عرض طلبات المستخدمين الآخرين فقط (بدون طلبات المستخدم الحالي)
          query = exchangeCollection
            .where('type', '==', 'request');
        } else if (tabType === 'my') {
          // عرض إعلانات المستخدم الحالي فقط (عروض وطلبات)
          query = exchangeCollection
            .where('userId', '==', currentUser.uid);
        } else {
          // حالة افتراضية - عرض جميع الإعلانات
          query = exchangeCollection;
        }
        
        // إعداد الاستماع في الوقت الحقيقي
        window.currentExchangeListener = query.onSnapshot((snapshot) => {
        
        // تصفية النتائج وتنظيمها حسب المستوى
        let filteredDocs = [];
        
        // إعادة تعيين الإحصائيات
        window.exchangeStats = {
          total: 0,
          offers: 0,
          requests: 0,
          byLevel: {}
        };
        
        // إعادة تعيين الإحصائيات العامة لجميع الإعلانات
        let allOffers = 0;
        let allRequests = 0;
        
        snapshot.forEach(doc => {
          const data = doc.data();
          
          // تحديث الإحصائيات العامة (لعدادات التبويبات)
          if (data.type === 'offer' && data.userId !== currentUser.uid) {
            allOffers++;
          } else if (data.type === 'request' && data.userId !== currentUser.uid) {
            allRequests++;
          }
          
          // في تبويب العروض، نعرض فقط عروض المستخدمين الآخرين
          if (tabType === 'offers' && data.userId === currentUser.uid) {
            return; // تخطي عروض المستخدم الحالي
          }
          
          // في تبويب الطلبات، نعرض فقط طلبات المستخدمين الآخرين
          if (tabType === 'requests' && data.userId === currentUser.uid) {
            return; // تخطي طلبات المستخدم الحالي
          }
          
          // إضافة الوثيقة إلى القائمة المصفاة
          filteredDocs.push({ id: doc.id, data: data });
          
          // تحديث الإحصائيات للتبويب الحالي
          window.exchangeStats.total++;
          
          if (data.type === 'offer') {
            window.exchangeStats.offers++;
          } else if (data.type === 'request') {
            window.exchangeStats.requests++;
          }
          
          // تحديث إحصائيات المستويات
          const level = data.bookLevel || 'غير محدد';
          if (!window.exchangeStats.byLevel[level]) {
            window.exchangeStats.byLevel[level] = {
              total: 0,
              offers: 0,
              requests: 0
            };
          }
          
          window.exchangeStats.byLevel[level].total++;
          
          if (data.type === 'offer') {
            window.exchangeStats.byLevel[level].offers++;
          } else if (data.type === 'request') {
            window.exchangeStats.byLevel[level].requests++;
          }
        });
        
        // تحديث المتغيرات العامة للإحصائيات
        window.allOffers = allOffers;
        window.allRequests = allRequests;
        
        // تحديث عدادات التبويبات
        updateTabCounts();
        
        // إنشاء قائمة المستويات للتصفية
        renderLevelFilters();
        
        // عرض الإعلانات المصفاة
        if (filteredDocs.length === 0) {
          listingsDiv.innerHTML = `<div class="exchange-empty">لا توجد إعلانات حالياً</div>`;
          return;
        }
        
        // تخزين الوثائق المصفاة في متغير عام للاستخدام في التصفية
        window.filteredExchangeDocs = filteredDocs;
        
        // عرض الإعلانات المصفاة
        renderFilteredExchanges();
        
      }, (error) => {
        console.error('Error listening to exchanges:', error);
        listingsDiv.innerHTML = `
          <div class="exchange-empty">حدث خطأ في تحميل الإعلانات</div>
        `;
        updateConnectionStatus(false);
      });
      
      } catch (error) {
        console.error('Error setting up exchange listener:', error);
        listingsDiv.innerHTML = `
          <div class="exchange-empty">حدث خطأ في تحميل الإعلانات</div>
        `;
        updateConnectionStatus(false);
      }
    }
    
    // تحديث عدادات التبويبات
    function updateTabCounts() {
      // استخدام الإحصائيات العامة التي تم حسابها
      const offersElement = document.getElementById('offersCount');
      const requestsElement = document.getElementById('requestsCount');
      
      if (offersElement) {
        offersElement.textContent = allOffers;
      }
      
      if (requestsElement) {
        requestsElement.textContent = allRequests;
      }
      
      // تم إزالة رسالة التصحيح من الكونسول
    }
    
    // إنشاء قائمة المستويات للتصفية
    function renderLevelFilters() {
      const levelsListDiv = document.getElementById('exchangeLevelsList');
      levelsListDiv.innerHTML = '';
      
      // إضافة زر "الكل"
      const allButton = document.createElement('button');
      allButton.className = 'exchange-level-btn' + (currentExchangeLevel === null ? ' active' : '');
      allButton.textContent = 'الكل';
      allButton.onclick = () => switchExchangeLevel(null);
      levelsListDiv.appendChild(allButton);
      
      // إضافة أزرار المستويات
      Object.keys(exchangeStats.byLevel).sort().forEach(level => {
        const stats = exchangeStats.byLevel[level];
        const button = document.createElement('button');
        button.className = 'exchange-level-btn' + (level === currentExchangeLevel ? ' active' : '');
        button.dataset.level = level;
        
        // إضافة عداد للمستوى
        const countSpan = document.createElement('span');
        countSpan.className = 'exchange-level-count';
        countSpan.textContent = stats.total;
        
        button.textContent = level + ' ';
        button.appendChild(countSpan);
        
        button.onclick = () => switchExchangeLevel(level);
        levelsListDiv.appendChild(button);
      });
    }
    
    // عرض الإعلانات المصفاة حسب المستوى المحدد
    function renderFilteredExchanges() {
      if (!window.filteredExchangeDocs) return;
      
      const listingsDiv = document.getElementById('exchangeListings');
      listingsDiv.innerHTML = '';
      
      // تصفية حسب المستوى المحدد
      let displayDocs = window.filteredExchangeDocs;
      
      if (currentExchangeLevel) {
        displayDocs = displayDocs.filter(item => 
          (item.data.bookLevel || 'غير محدد') === currentExchangeLevel
        );
      }
      
      if (displayDocs.length === 0) {
        listingsDiv.innerHTML = `<div class="exchange-empty">لا توجد إعلانات في هذا المستوى</div>`;
        return;
      }
      
      // تنظيم الإعلانات حسب المستوى
      const docsByLevel = {};
      
      displayDocs.forEach(({ id, data }) => {
        const level = data.bookLevel || 'غير محدد';
        
        if (!docsByLevel[level]) {
          docsByLevel[level] = [];
        }
        
        docsByLevel[level].push({ id, data });
      });
      
      // عرض الإعلانات مجمعة حسب المستوى
      Object.keys(docsByLevel).sort().forEach(level => {
        // إذا كان هناك مستوى محدد، لا نحتاج لعنوان المستوى
        if (!currentExchangeLevel) {
          const levelTitle = document.createElement('div');
          levelTitle.className = 'exchange-level-title';
          levelTitle.textContent = level;
          listingsDiv.appendChild(levelTitle);
        }
        
        const levelGroup = document.createElement('div');
        levelGroup.className = 'exchange-level-group';
        
        docsByLevel[level].forEach(({ id, data }) => {
          const exchange = data;
          const exchangeId = id;
          const isOwner = exchange.userId === currentUser.uid;
          
          // استخدام تنسيق التاريخ بالأرقام العادية
          let exchangeDate = 'غير معروف';
          if (exchange.createdAt) {
            const date = new Date(exchange.createdAt.toDate());
            exchangeDate = `${date.getDate()}/${date.getMonth() + 1}/${date.getFullYear()}`;
          }
          
          // البحث عن صورة الكتاب - أولاً من بيانات المستوى المحدثة، ثم من الإعلان
          let bookImageUrl = null;
          
          // البحث في بيانات المستوى أولاً للحصول على أحدث صورة
          if (exchange.bookLevel && exchange.bookName) {
            const level = levels.find(l => l.name === exchange.bookLevel);
            if (level) {
              // البحث في booksWithImages أولاً (الصور المحدثة)
              if (level.booksWithImages && level.booksWithImages[exchange.bookName]) {
                bookImageUrl = level.booksWithImages[exchange.bookName];
              }
              // إذا لم توجد، ابحث في bookImages (الصور القديمة)
              else if (level.bookImages && level.bookImages[exchange.bookName]) {
                bookImageUrl = level.bookImages[exchange.bookName];
              }
            }
          }
          
          // إذا لم توجد صورة في المستوى، استخدم صورة الإعلان (إن وجدت)
          if (!bookImageUrl && exchange.bookImageUrl) {
            bookImageUrl = exchange.bookImageUrl;
          }
          

          const card = document.createElement('div');
          card.className = `exchange-card ${exchange.type}`;

          card.innerHTML = `
            ${isOwner && currentExchangeType === 'my' ? `<div class="exchange-checkbox-container"><input type="checkbox" class="exchange-checkbox" data-exchange-id="${exchangeId}" onchange="updateSelectedCount()"></div>` : ''}
            ${!isOwner && isAdmin && currentExchangeType !== 'my' ? `<div class="exchange-checkbox-container"><input type="checkbox" class="admin-exchange-checkbox" data-exchange-id="${exchangeId}" onchange="adminUpdateSelectedCount()"></div>` : ''}
            <div class="exchange-type ${exchange.type}">${exchange.type === 'offer' ? 'عرض' : 'طلب'}</div>
            <div class="exchange-book-title">
              ${exchange.bookName}
              ${bookImageUrl ? `<button class="view-exchange-image-btn" onclick="event.stopPropagation(); showImageModal('${bookImageUrl}', '${exchange.bookName}')" title="عرض صورة الكتاب">👁️</button>` : '<span style="color: #e53e3e; font-size: 0.8em; margin-right: 10px;">لا توجد صورة</span>'}
            </div>
            <div style="color: #4a5568; margin-bottom: 5px;">
              ${exchange.bookLevel ? `المستوى: <strong>${exchange.bookLevel}</strong>` : ''}
            </div>
            <div class="exchange-book-count">
              ${exchange.type === 'offer' ? 'عدد الكتب المتاحة: ' : 'عدد الكتب المطلوبة : '}
              <strong>${exchange.count}</strong>
            </div>
            <div class="exchange-card-details">
              <div class="exchange-user-info">
                <div class="exchange-user-name">${exchange.userName}</div>
                                  <div class="exchange-user-contact">
                    <div>${exchange.userEmail}</div>
                    <div>${exchange.userPhone}</div>
                    <div>تاريخ النشر: ${exchangeDate}</div>
                    ${isOwner && exchange.expiryDate ? `<div style="color: #e53e3e;">تاريخ الحذف التلقائي: ${new Date(exchange.expiryDate.toDate()).getDate()}/${new Date(exchange.expiryDate.toDate()).getMonth() + 1}/${new Date(exchange.expiryDate.toDate()).getFullYear()}</div>` : ''}
                  </div>
              </div>
              ${isOwner || isAdmin ? `
                <div class="exchange-actions">
                  <button class="exchange-action-btn exchange-edit-btn" onclick="event.stopPropagation(); showExchangeForm('${exchange.type}', '${exchangeId}')">تعديل</button>
                  <button class="exchange-action-btn exchange-delete-btn" onclick="event.stopPropagation(); deleteExchange('${exchangeId}')">حذف</button>
                  ${isAdmin && !isOwner ? `<div style="font-size: 0.8em; color: #4a5568; margin-top: 5px;">تعديل بصلاحية المدير</div>` : ''}
                </div>
              ` : ''}
            </div>
          `;
          
          // إضافة معالج النقر لتوسيع/طي البطاقة
          card.onclick = function() {
            this.classList.toggle('expanded');
          };
          
          levelGroup.appendChild(card);
        });
        
        listingsDiv.appendChild(levelGroup);
      });
    }

    // Function to update loading status
    function updateLoadingStatus(message) {
      const statusElement = document.getElementById('loading-status');
      if (statusElement) {
        statusElement.textContent = message;
      }
    }

    // Check for storage access and inform user
    function checkStorageAccess() {
      updateLoadingStatus('جاري فحص التخزين...');
      try {
        localStorage.setItem('test', 'test');
        localStorage.removeItem('test');
      } catch (e) {
        
        // Show a brief notification to user
        setTimeout(() => {
          const notification = document.createElement('div');
          notification.style.cssText = `
            position: fixed; top: 20px; right: 20px; z-index: 10000;
            background: #fff3cd; border: 1px solid #ffeaa7; border-radius: 8px;
            padding: 15px; max-width: 300px; font-size: 0.9em;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15); color: #856404;
          `;
          notification.innerHTML = `
            <strong>🔒 إعدادات الخصوصية</strong><br>
            التطبيق يعمل بشكل طبيعي، لكن قد تحتاج لتسجيل الدخول مرة أخرى بعد إعادة تشغيل المتصفح.
            <button onclick="this.parentElement.remove()" style="float: left; margin-top: 5px; background: none; border: none; color: #856404; cursor: pointer;">✕</button>
          `;
          document.body.appendChild(notification);
          
          // Auto remove after 10 seconds
          setTimeout(() => {
            if (notification.parentElement) {
              notification.remove();
            }
          }, 10000);
        }, 2000);
      }
    }

    // Wait for Firebase Auth to be fully ready before starting the app
    let authReady = false;
    let authStateReceived = false;

        // Listen to auth state and mark as ready
    auth.onAuthStateChanged((user) => {
      if (!authReady) {
        authStateReceived = true;
        authReady = true;

        // Now start the application
        setTimeout(() => {
          updateLoadingStatus('جاري تهيئة التطبيق...');
          checkStorageAccess();

          setTimeout(() => {
            updateLoadingStatus('جاري تحميل البيانات...');
            initializeAndSyncData();
          }, 500);
        }, 500);
      }
    });

    // Fallback: if auth state doesn't change within 3 seconds, start anyway
    setTimeout(() => {
      if (!authReady) {
        updateLoadingStatus('جاري بدء التطبيق...');
        authReady = true;
        checkStorageAccess();

        setTimeout(() => {
          updateLoadingStatus('جاري تحميل البيانات...');
          initializeAndSyncData();
        }, 500);
      }
    }, 3000);

         // Function to show temporary notification
     function showTemporaryAlert(message, type = 'success') {
       const notification = document.createElement('div');
       notification.style.cssText = `
         position: fixed;
         top: 20px;
         right: 20px;
         padding: 15px 25px;
         border-radius: 8px;
         font-size: 1em;
         z-index: 10000;
         transition: all 0.3s ease;
         box-shadow: 0 4px 12px rgba(0,0,0,0.15);
         ${type === 'success' ? 
           'background: #d1fae5; color: #065f46; border: 1px solid #34d399;' : 
           'background: #fee2e2; color: #991b1b; border: 1px solid #f87171;'}
       `;
       notification.textContent = message;
       document.body.appendChild(notification);
       
       // Fade out and remove after 3 seconds
       setTimeout(() => {
         notification.style.opacity = '0';
         setTimeout(() => notification.remove(), 300);
       }, 3000);
     }

     window.toggleUserActivation = async function(userId, newStatus) {
       if (!isAdmin) return;
       try {
         await usersCollection.doc(userId).update({
           isActive: newStatus
         });
         showTemporaryAlert(newStatus ? 'تم تفعيل المستخدم بنجاح' : 'تم إلغاء تفعيل المستخدم');
         // Do not call loadUsersForAdmin() here to avoid jarring UI refresh.
         // The toggle switch already reflects the new state visually.
       } catch (error) {
         showTemporaryAlert('خطأ في تحديث حالة المستخدم.', 'error');
         loadUsersForAdmin(); // Refresh on error to revert the optimistic UI change
       }
     };

     window.toggleContentEditorRole = async function(userId, newStatus) {
       if (!isAdmin) {
         showTemporaryAlert("ليس لديك الصلاحية لتنفيذ هذا الإجراء.", 'error');
         loadUsersForAdmin(); // Revert toggle
         return;
       }
       if (userId === currentUser.uid) {
         showTemporaryAlert("لا يمكنك تغيير صلاحياتك الخاصة.", 'error');
         loadUsersForAdmin(); // Revert toggle
         return;
       }
       try {
         await usersCollection.doc(userId).update({
           canEditContent: newStatus
         });
         showTemporaryAlert(
           newStatus ? 
           'تم منح صلاحية التحرير للمستخدم بنجاح' : 
           'تم إلغاء صلاحية التحرير للمستخدم'
         );
         // No need to reload the whole table, but we might need to update the role text.
         loadUsersForAdmin(); 
       } catch (error) {
         showTemporaryAlert("حدث خطأ أثناء تحديث صلاحية المستخدم.", 'error');
         loadUsersForAdmin(); // Revert toggle on error
       }
     }
     
    // دالة إنشاء نسخة احتياطية من قاعدة البيانات
    async function createBackup() {
      // التحقق من صلاحيات المدير
      if (!isAdmin) {
        showTemporaryAlert('ليس لديك صلاحية للقيام بهذه العملية', 'error');
        return;
      }
      
      try {
        // إظهار رسالة انتظار
        showTemporaryAlert('جاري إنشاء نسخة احتياطية...', 'info');
        
        // جمع البيانات من مجموعات Firestore المختلفة
        const backup = {
          timestamp: new Date().toISOString(),
          createdBy: currentUser ? currentUser.email : 'unknown',
          data: {}
        };
        
        // الحصول على بيانات التطبيق (المستويات والكتب)
        const appDataSnapshot = await appDataDocRef.get();
        if (appDataSnapshot.exists) {
          backup.data.appData = appDataSnapshot.data();
        }
        
        // الحصول على بيانات المستخدمين
        const usersSnapshot = await usersCollection.get();
        backup.data.users = [];
        usersSnapshot.forEach(doc => {
          // نحذف البيانات الحساسة مثل كلمات المرور
          const userData = doc.data();
          delete userData.password;
          backup.data.users.push({
            id: doc.id,
            ...userData
          });
        });
        
        // الحصول على بيانات الكتب المختارة للمستخدمين
        const userChosenBooksSnapshot = await db.collection('userChosenBooks').get();
        backup.data.chosenBooks = [];
        userChosenBooksSnapshot.forEach(doc => {
          backup.data.chosenBooks.push({
            id: doc.id,
            ...doc.data()
          });
        });
        
        // الحصول على بيانات تبادل الكتب
        const exchangesSnapshot = await exchangeCollection.get();
        backup.data.exchanges = [];
        exchangesSnapshot.forEach(doc => {
          backup.data.exchanges.push({
            id: doc.id,
            ...doc.data()
          });
        });
        
        // الحصول على بيانات أرشيف العمليات
        const archiveSnapshot = await operationsArchiveCollection.get();
        backup.data.operationsArchive = [];
        archiveSnapshot.forEach(doc => {
          backup.data.operationsArchive.push({
            id: doc.id,
            ...doc.data()
          });
        });
        
        // تحويل البيانات إلى نص JSON
        const backupJSON = JSON.stringify(backup, null, 2);
        
        // إنشاء ملف للتنزيل
        const blob = new Blob([backupJSON], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        
        // إنشاء رابط وهمي للتنزيل
        const a = document.createElement('a');
        a.href = url;
        a.download = `bookapp_backup_${new Date().toISOString().replace(/:/g, '-')}.json`;
        document.body.appendChild(a);
        a.click();
        
        // تنظيف
        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 0);
        
        showTemporaryAlert('تم إنشاء النسخة الاحتياطية بنجاح', 'success');
      } catch (error) {
        console.error('Error creating backup:', error);
        showTemporaryAlert('حدث خطأ أثناء إنشاء النسخة الاحتياطية', 'error');
      }
    }
    
    // دالة استعادة قاعدة البيانات من نسخة احتياطية
    async function restoreBackup() {
      // التحقق من صلاحيات المدير
      if (!isAdmin) {
        showTemporaryAlert('ليس لديك صلاحية للقيام بهذه العملية', 'error');
        return;
      }
      
      try {
        // إنشاء عنصر input لاختيار ملف
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'application/json';
        
        fileInput.onchange = async (e) => {
          const file = e.target.files[0];
          if (!file) return;
          
          // قراءة الملف
          const reader = new FileReader();
          
          reader.onload = async (event) => {
            try {
              // تحليل البيانات
              const backup = JSON.parse(event.target.result);
              
              // التحقق من صحة بنية البيانات
              if (!backup.data) {
                showTemporaryAlert('ملف النسخة الاحتياطية غير صالح', 'error');
                return;
              }
              
              // طلب تأكيد من المستخدم
              if (!confirm('سيؤدي استعادة النسخة الاحتياطية إلى استبدال جميع البيانات الحالية. هل أنت متأكد من المتابعة؟')) {
                return;
              }
              
              showTemporaryAlert('جاري استعادة البيانات...', 'info');
              
              // استعادة بيانات التطبيق (المستويات والكتب)
              if (backup.data.appData) {
                await appDataDocRef.set(backup.data.appData);
              }
              
              // استعادة بيانات المستخدمين
              if (backup.data.users && backup.data.users.length > 0) {
                // حذف المستخدمين الحاليين واستبدالهم بالمستخدمين من النسخة الاحتياطية
                const batch = db.batch();
                
                // الحصول على جميع المستخدمين الحاليين لحذفهم
                const currentUsers = await usersCollection.get();
                currentUsers.forEach(doc => {
                  // لا نحذف المستخدم الحالي
                  if (currentUser && doc.id !== currentUser.uid) {
                    batch.delete(usersCollection.doc(doc.id));
                  }
                });
                
                // إضافة المستخدمين من النسخة الاحتياطية
                for (const user of backup.data.users) {
                  const userId = user.id;
                  delete user.id; // حذف الـ ID من البيانات
                  
                  // لا نستبدل المستخدم الحالي
                  if (currentUser && userId !== currentUser.uid) {
                    batch.set(usersCollection.doc(userId), user);
                  }
                }
                
                await batch.commit();
              }
              
              // استعادة بيانات الكتب المختارة
              if (backup.data.chosenBooks && backup.data.chosenBooks.length > 0) {
                const batch = db.batch();
                const userChosenBooksCollection = db.collection('userChosenBooks');
                
                // حذف جميع الكتب المختارة الحالية
                const currentChosenBooks = await userChosenBooksCollection.get();
                currentChosenBooks.forEach(doc => {
                  batch.delete(userChosenBooksCollection.doc(doc.id));
                });
                
                // إضافة الكتب المختارة من النسخة الاحتياطية
                for (const book of backup.data.chosenBooks) {
                  const bookId = book.id;
                  delete book.id;
                  batch.set(userChosenBooksCollection.doc(bookId), book);
                }
                
                await batch.commit();
              }
              
              // استعادة بيانات تبادل الكتب
              if (backup.data.exchanges && backup.data.exchanges.length > 0) {
                const batch = db.batch();
                
                // حذف جميع بيانات تبادل الكتب الحالية
                const currentExchanges = await exchangeCollection.get();
                currentExchanges.forEach(doc => {
                  batch.delete(exchangeCollection.doc(doc.id));
                });
                
                // إضافة بيانات تبادل الكتب من النسخة الاحتياطية
                for (const exchange of backup.data.exchanges) {
                  const exchangeId = exchange.id;
                  delete exchange.id;
                  
                  // تحويل الطوابع الزمنية إلى كائنات Firestore Timestamp
                  if (exchange.createdAt) {
                    exchange.createdAt = firebase.firestore.Timestamp.fromDate(new Date(exchange.createdAt.seconds * 1000));
                  }
                  if (exchange.updatedAt) {
                    exchange.updatedAt = firebase.firestore.Timestamp.fromDate(new Date(exchange.updatedAt.seconds * 1000));
                  }
                  if (exchange.expiryDate) {
                    exchange.expiryDate = firebase.firestore.Timestamp.fromDate(new Date(exchange.expiryDate.seconds * 1000));
                  }
                  
                  batch.set(exchangeCollection.doc(exchangeId), exchange);
                }
                
                await batch.commit();
              }
              
              // استعادة بيانات أرشيف العمليات
              if (backup.data.operationsArchive && backup.data.operationsArchive.length > 0) {
                const batch = db.batch();
                
                // حذف جميع بيانات الأرشيف الحالية
                const currentArchive = await operationsArchiveCollection.get();
                currentArchive.forEach(doc => {
                  batch.delete(operationsArchiveCollection.doc(doc.id));
                });
                
                // إضافة بيانات الأرشيف من النسخة الاحتياطية
                for (const operation of backup.data.operationsArchive) {
                  const operationId = operation.id;
                  delete operation.id;
                  
                  // تحويل الطوابع الزمنية إلى كائنات Firestore Timestamp
                  if (operation.timestamp) {
                    operation.timestamp = firebase.firestore.Timestamp.fromDate(new Date(operation.timestamp.seconds * 1000));
                  }
                  
                  batch.set(operationsArchiveCollection.doc(operationId), operation);
                }
                
                await batch.commit();
              }
              
              // إضافة سجل في الأرشيف عن عملية الاستعادة
              await addToArchive('restore', 'database', {
                message: 'تمت استعادة قاعدة البيانات من نسخة احتياطية',
                backupDate: backup.timestamp || 'غير معروف'
              });
              
              showTemporaryAlert('تمت استعادة النسخة الاحتياطية بنجاح. سيتم تحديث الصفحة.', 'success');
              
              // إعادة تحميل الصفحة بعد ثانيتين
              setTimeout(() => {
                window.location.reload();
              }, 2000);
              
            } catch (error) {
              console.error('Error parsing backup file:', error);
              showTemporaryAlert('حدث خطأ أثناء قراءة ملف النسخة الاحتياطية', 'error');
            }
          };
          
          reader.readAsText(file);
        };
        
        fileInput.click();
      } catch (error) {
        console.error('Error restoring backup:', error);
        showTemporaryAlert('حدث خطأ أثناء استعادة النسخة الاحتياطية', 'error');
      }
    }

    // Sidebar functionality
    let sidebarOpen = false;

    function toggleSidebar() {
      const sidebar = document.getElementById('sidebar');
      const overlay = document.getElementById('sidebar-overlay');
      const toggleBtn = document.getElementById('sidebar-toggle');
      
      sidebarOpen = !sidebarOpen;
      
      if (sidebarOpen) {
        sidebar.style.right = '0px';
        overlay.classList.add('show');
        toggleBtn.innerHTML = '✕';
        toggleBtn.style.background = 'linear-gradient(135deg, #e53e3e 0%, #c53030 100%)';
      } else {
        sidebar.style.right = '-350px';
        overlay.classList.remove('show');
        toggleBtn.innerHTML = '☰';
        toggleBtn.style.background = 'linear-gradient(135deg, #667eea 0%, #63b3ed 100%)';
      }
    }

    function closeSidebar() {
      if (sidebarOpen) {
        toggleSidebar();
      }
    }

    // Initialize sidebar functionality
    function initSidebar() {
      const toggleBtn = document.getElementById('sidebar-toggle');
      const overlay = document.getElementById('sidebar-overlay');
      
      if (toggleBtn) {
        toggleBtn.addEventListener('click', toggleSidebar);
      }
      
      if (overlay) {
        overlay.addEventListener('click', closeSidebar);
      }

      // Sync sidebar elements with original elements
      syncSidebarElements();
      
      // Close sidebar when clicking on specific sidebar buttons (exclude notifications and messages)
      const sidebarBtns = document.querySelectorAll('.sidebar-btn');
      sidebarBtns.forEach(btn => {
        // Don't auto-close for notifications and messages buttons
        if (btn.id !== 'sidebar-notificationsBtn' && btn.id !== 'sidebar-messagesBtn') {
          btn.addEventListener('click', () => {
            setTimeout(closeSidebar, 300); // Small delay for better UX
          });
        }
      });
    }

    function syncSidebarElements() {
      // Sync welcome text
      const welcomeText = document.getElementById('welcome-text');
      const sidebarWelcomeText = document.getElementById('sidebar-welcome-text');
      if (welcomeText && sidebarWelcomeText) {
        sidebarWelcomeText.textContent = welcomeText.textContent;
      }

      // Sync user name
      const sidebarUserName = document.getElementById('sidebar-user-name');
      if (sidebarUserName && currentUser) {
        const userName = currentUser.name || currentUser.displayName || currentUser.email || 'مستخدم';
        sidebarUserName.textContent = userName;
      }

      // Sync connection status
      const connectionStatus = document.getElementById('connectionStatus');
      const sidebarConnectionStatus = document.getElementById('sidebar-connectionStatus');
      const connectionStatusDot = document.getElementById('connectionStatusDot');
      const sidebarConnectionStatusDot = document.getElementById('sidebar-connectionStatusDot');
      const connectionStatusText = document.getElementById('connectionStatusText');
      const sidebarConnectionStatusText = document.getElementById('sidebar-connectionStatusText');
      
      if (connectionStatusDot && sidebarConnectionStatusDot) {
        sidebarConnectionStatusDot.style.backgroundColor = connectionStatusDot.style.backgroundColor;
      }
      if (connectionStatusText && sidebarConnectionStatusText) {
        sidebarConnectionStatusText.textContent = connectionStatusText.textContent;
      }

      // Sync notification badges
      const notificationsBadge = document.getElementById('notificationsBadge');
      const sidebarNotificationsBadge = document.getElementById('sidebar-notificationsBadge');
      if (notificationsBadge && sidebarNotificationsBadge) {
        if (notificationsBadge.style.display !== 'none' && notificationsBadge.textContent !== '0') {
          sidebarNotificationsBadge.style.display = 'flex';
          sidebarNotificationsBadge.textContent = notificationsBadge.textContent;
        } else {
          sidebarNotificationsBadge.style.display = 'none';
        }
      }

      // Sync messages badges
      const messagesBadge = document.getElementById('messagesBadge');
      const sidebarMessagesBadge = document.getElementById('sidebar-messagesBadge');
      if (messagesBadge && sidebarMessagesBadge) {
        if (messagesBadge.style.display !== 'none' && messagesBadge.textContent !== '0') {
          sidebarMessagesBadge.style.display = 'flex';
          sidebarMessagesBadge.textContent = messagesBadge.textContent;
        } else {
          sidebarMessagesBadge.style.display = 'none';
        }
      }

      // Update sidebar buttons visibility based on user permissions
      updateSidebarButtonsVisibility();
    }

    // Update sidebar buttons visibility based on user permissions
    function updateSidebarButtonsVisibility() {
      // Admin-only buttons
      const adminButtons = [
        'sidebar-adminMessageBtn',
        'sidebar-adminPanelBtn', 
        'sidebar-archiveBtn',
        'sidebar-backupBtn',
        'sidebar-restoreBtn',
        'sidebar-exportBtn',
        'sidebar-importBtn'
      ];

      adminButtons.forEach(buttonId => {
        const button = document.getElementById(buttonId);
        if (button) {
          button.style.display = isAdmin ? 'flex' : 'none';
        }
      });

      // Contact admin button (show for non-admin users)
      const contactAdminBtn = document.getElementById('sidebar-contactAdminBtn');
      if (contactAdminBtn) {
        contactAdminBtn.style.display = isAdmin ? 'none' : 'flex';
      }

      // Levels settings button (show based on edit permissions)
      const levelsSettingsBtn = document.getElementById('sidebar-levelsSettingsBtn');
      if (levelsSettingsBtn) {
        const hasEditPermission = isAdmin || (currentUser && currentUser.canEditContent);
        levelsSettingsBtn.style.display = hasEditPermission ? 'flex' : 'none';
      }
    }

    // Connect sidebar buttons to original functions
    function connectSidebarButtons() {
      // Refresh button
      const sidebarRefreshBtn = document.getElementById('sidebar-refreshAppBtn');
      if (sidebarRefreshBtn && typeof refreshApp === 'function') {
        sidebarRefreshBtn.onclick = refreshApp;
      }

      // Notifications button
      const sidebarNotificationsBtn = document.getElementById('sidebar-notificationsBtn');
      if (sidebarNotificationsBtn) {
        sidebarNotificationsBtn.onclick = toggleSidebarNotifications;
      }

      // Messages button
      const sidebarMessagesBtn = document.getElementById('sidebar-messagesBtn');
      if (sidebarMessagesBtn) {
        sidebarMessagesBtn.onclick = toggleSidebarMessages;
      }

      // Levels settings button
      const sidebarLevelsSettingsBtn = document.getElementById('sidebar-levelsSettingsBtn');
      if (sidebarLevelsSettingsBtn) {
        sidebarLevelsSettingsBtn.onclick = function() {
          renderLevelsSettingsModal();
          document.getElementById('levelsSettingsModal').style.display = 'flex';
        };
      }

      // Admin message button
      const sidebarAdminMessageBtn = document.getElementById('sidebar-adminMessageBtn');
      if (sidebarAdminMessageBtn) {
        sidebarAdminMessageBtn.onclick = function() {
          if (isAdmin) {
            showAdminMessageModal();
          } else {
            showTemporaryAlert('هذه الخاصية متاحة فقط للمدير', 'error');
          }
        };
      }

      // Contact admin button
      const sidebarContactAdminBtn = document.getElementById('sidebar-contactAdminBtn');
      if (sidebarContactAdminBtn) {
        sidebarContactAdminBtn.onclick = function() {
          if (currentUser) {
            showContactAdminModal();
          } else {
            showTemporaryAlert('يجب تسجيل الدخول أولاً', 'error');
          }
        };
      }

      // Account settings button
      const sidebarAccountSettingsBtn = document.getElementById('sidebar-accountSettingsBtn');
      if (sidebarAccountSettingsBtn) {
        sidebarAccountSettingsBtn.onclick = function() {
          showAccountSettingsModal();
        };
      }

      // Admin Panel button
      const sidebarAdminPanelBtn = document.getElementById('sidebar-adminPanelBtn');
      if (sidebarAdminPanelBtn) {
        sidebarAdminPanelBtn.onclick = function() {
          if (isAdmin) {
            showAdminModal();
          } else {
            showTemporaryAlert('هذه الخاصية متاحة فقط للمدير', 'error');
          }
        };
      }

      // Archive button
      const sidebarArchiveBtn = document.getElementById('sidebar-archiveBtn');
      if (sidebarArchiveBtn) {
        sidebarArchiveBtn.onclick = function() {
          if (isAdmin) {
            showArchiveModal();
          } else {
            showTemporaryAlert('هذه الخاصية متاحة فقط للمدير', 'error');
          }
        };
      }



      // Backup button
      const sidebarBackupBtn = document.getElementById('sidebar-backupBtn');
      if (sidebarBackupBtn) {
        sidebarBackupBtn.onclick = function() {
          if (isAdmin) {
            createBackup();
          } else {
            showTemporaryAlert('هذه الخاصية متاحة فقط للمدير', 'error');
          }
        };
      }

      // Restore button
      const sidebarRestoreBtn = document.getElementById('sidebar-restoreBtn');
      if (sidebarRestoreBtn) {
        sidebarRestoreBtn.onclick = function() {
          if (isAdmin) {
            restoreBackup();
          } else {
            showTemporaryAlert('هذه الخاصية متاحة فقط للمدير', 'error');
          }
        };
      }

      // Export button
      const sidebarExportBtn = document.getElementById('sidebar-exportBtn');
      if (sidebarExportBtn) {
        sidebarExportBtn.onclick = function() {
          if (isAdmin) {
            exportJSON();
          } else {
            showTemporaryAlert('هذه الخاصية متاحة فقط للمدير', 'error');
          }
        };
      }

      // Import button
      const sidebarImportBtn = document.getElementById('sidebar-importBtn');
      if (sidebarImportBtn) {
        sidebarImportBtn.onclick = function() {
          if (isAdmin) {
            importJSON();
          } else {
            showTemporaryAlert('هذه الخاصية متاحة فقط للمدير', 'error');
          }
        };
      }

      // Logout button
      const sidebarLogoutBtn = document.getElementById('sidebar-logoutBtn');
      if (sidebarLogoutBtn) {
        sidebarLogoutBtn.onclick = async function() {
          try {
            // Clean up all listeners before signing out
            cleanupAllListeners();
            
            await auth.signOut();
            showTemporaryAlert('تم تسجيل الخروج بنجاح', 'success');
          } catch (error) {
            console.error('Logout error:', error);
            showTemporaryAlert('خطأ في تسجيل الخروج: ' + error.message, 'error');
          }
        };
      }
    }

    // Initialize sidebar when main app is shown
    const originalShowMainApp = window.showMainApp;
    if (typeof originalShowMainApp === 'function') {
      window.showMainApp = function() {
        originalShowMainApp();
        setTimeout(() => {
          initSidebar();
          connectSidebarButtons();
        }, 100);
      };
    } else {
      // Fallback initialization
      document.addEventListener('DOMContentLoaded', () => {
        setTimeout(() => {
          initSidebar();
          connectSidebarButtons();
        }, 1000);
      });
    }

    // Sidebar notifications and messages functionality
    let isSidebarNotificationsOpen = false;
    let isSidebarMessagesOpen = false;

    // Toggle sidebar notifications dropdown
    function toggleSidebarNotifications() {
      const dropdown = document.getElementById('sidebar-notificationsDropdown');
      if (!dropdown) return;
      
      isSidebarNotificationsOpen = !isSidebarNotificationsOpen;
      
      if (isSidebarNotificationsOpen) {
        dropdown.style.display = 'block';
        notificationsLoaded = 0;
        renderSidebarNotificationsList();
        
        // Mark all notifications as read when opening
        markAllNotificationsAsRead();
        
        // Reset badge count
        unreadNotifications = 0;
        updateNotificationsBadge();
      } else {
        dropdown.style.display = 'none';
      }
    }

    // Toggle sidebar messages dropdown
    function toggleSidebarMessages() {
      const dropdown = document.getElementById('sidebar-messagesDropdown');
      if (!dropdown) return;
      
      isSidebarMessagesOpen = !isSidebarMessagesOpen;
      
      if (isSidebarMessagesOpen) {
        dropdown.style.display = 'block';
        messagesLoaded = 0;
        renderSidebarMessagesList();
        
        // Mark all messages as read when opening
        markAllMessagesAsRead();
        
        // Reset badge count
        unreadMessages = 0;
        updateMessagesBadge();
      } else {
        dropdown.style.display = 'none';
      }
    }

    // Render sidebar notifications list
    function renderSidebarNotificationsList() {
      const listElement = document.getElementById('sidebar-notificationsList');
      const loadMoreElement = document.getElementById('sidebar-notificationsLoadMore');
      
      if (!listElement) return;
      
      if (notifications.length === 0) {
        listElement.innerHTML = '<div style="padding: 20px; text-align: center; color: #718096;">لا توجد إشعارات</div>';
        if (loadMoreElement) loadMoreElement.style.display = 'none';
        return;
      }
      
      const endIndex = Math.min(notificationsLoaded + notificationsPerPage, notifications.length);
      const visibleNotifications = notifications.slice(0, endIndex);
      
      listElement.innerHTML = '';
      
      visibleNotifications.forEach(notification => {
        const item = document.createElement('div');
        item.className = `notification-item ${!notification.read ? 'unread' : ''}`;
        item.style.cssText = 'padding: 12px; border-bottom: 1px solid #e2e8f0; cursor: pointer; transition: background-color 0.2s;';
        
        const timeText = formatNotificationTime(notification);
        
        item.innerHTML = `
          <div style="font-weight: 600; color: #2d3748; margin-bottom: 4px;">${notification.title}</div>
          <div style="color: #4a5568; font-size: 0.9em; margin-bottom: 4px;">${notification.message.substring(0, 80)}${notification.message.length > 80 ? '...' : ''}</div>
          <div style="color: #718096; font-size: 0.8em;">${timeText}</div>
        `;
        
        item.onmouseover = () => item.style.backgroundColor = '#f7fafc';
        item.onmouseout = () => item.style.backgroundColor = 'transparent';
        item.onclick = () => showNotificationDetail(notification);
        
        listElement.appendChild(item);
      });
      
      notificationsLoaded = endIndex;
      
      if (loadMoreElement) {
        if (notificationsLoaded < notifications.length) {
          loadMoreElement.style.display = 'block';
        } else {
          loadMoreElement.style.display = 'none';
        }
      }
    }

    // Render sidebar messages list
    function renderSidebarMessagesList() {
      const listElement = document.getElementById('sidebar-messagesList');
      const loadMoreElement = document.getElementById('sidebar-messagesLoadMore');
      
      if (!listElement) return;
      
      if (messages.length === 0) {
        listElement.innerHTML = '<div style="padding: 20px; text-align: center; color: #718096;">لا توجد رسائل</div>';
        if (loadMoreElement) loadMoreElement.style.display = 'none';
        return;
      }
      
      const endIndex = Math.min(messagesLoaded + messagesPerPage, messages.length);
      const visibleMessages = messages.slice(0, endIndex);
      
      listElement.innerHTML = '';
      
      visibleMessages.forEach(message => {
        const item = document.createElement('div');
        item.className = `notification-item ${!message.read ? 'unread' : ''}`;
        item.style.cssText = 'padding: 12px; border-bottom: 1px solid #e2e8f0; cursor: pointer; transition: background-color 0.2s; position: relative;';
        
        const timeText = formatMessageTime(message);
        
        let badgeText = 'رسالة إدارية';
        let messageContent = message.content || message.message || '';
        let senderInfo = '';
        
        if (isAdmin && message.type === 'user_to_admin') {
          badgeText = 'رسالة من مستخدم';
          senderInfo = `<div style="color: #667eea; font-size: 0.8em; margin-bottom: 2px;">من: ${message.fromUserName}</div>`;
        }
        
        // Check if message has attachment
        const attachmentIndicator = message.attachment ? 
          `<div style="color: #4299e1; font-size: 0.8em; margin-bottom: 2px;">📎 ${message.attachment.name}</div>` : '';
        
        item.innerHTML = `
          <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 4px;">
            <span style="background: ${message.type === 'user_to_admin' ? '#e53e3e' : '#667eea'}; color: white; padding: 2px 6px; border-radius: 10px; font-size: 0.7em;">${badgeText}</span>
            <button onclick="deleteMessage('${message.id}', event)" style="background: #e53e3e; color: white; border: none; border-radius: 50%; width: 18px; height: 18px; font-size: 0.7em; cursor: pointer;" title="حذف الرسالة">×</button>
          </div>
          ${senderInfo}
          <div style="font-weight: 600; color: #2d3748; margin-bottom: 4px;">${message.title}</div>
          <div style="color: #4a5568; font-size: 0.9em; margin-bottom: 4px;">${messageContent.substring(0, 80)}${messageContent.length > 80 ? '...' : ''}</div>
          ${attachmentIndicator}
          <div style="color: #718096; font-size: 0.8em;">${timeText}</div>
        `;
        
        item.onmouseover = () => item.style.backgroundColor = '#f7fafc';
        item.onmouseout = () => item.style.backgroundColor = 'transparent';
        item.onclick = () => showMessageDetail(message);
        
        listElement.appendChild(item);
      });
      
      messagesLoaded = endIndex;
      
      if (loadMoreElement) {
        if (messagesLoaded < messages.length) {
          loadMoreElement.style.display = 'block';
        } else {
          loadMoreElement.style.display = 'none';
        }
      }
    }

    // Close sidebar dropdowns when clicking outside
    document.addEventListener('click', (event) => {
      const sidebarNotificationsContainer = document.querySelector('.sidebar-notifications-container');
      const sidebarMessagesContainer = document.querySelectorAll('.sidebar-notifications-container')[1];
      
      if (sidebarNotificationsContainer && !sidebarNotificationsContainer.contains(event.target)) {
        if (isSidebarNotificationsOpen) {
          toggleSidebarNotifications();
        }
      }
      
      if (sidebarMessagesContainer && !sidebarMessagesContainer.contains(event.target)) {
        if (isSidebarMessagesOpen) {
          toggleSidebarMessages();
        }
      }
    });

// Update notifications badge for sidebar
function updateNotificationsBadge() {
  // Update sidebar notifications badge
  const sidebarBadge = document.getElementById('sidebar-notificationsBadge');
  
  if (sidebarBadge) {
    if (unreadNotifications > 0) {
      sidebarBadge.textContent = unreadNotifications > 99 ? '99+' : unreadNotifications;
      sidebarBadge.style.display = 'flex';
    } else {
      sidebarBadge.style.display = 'none';
    }
  }
  
  // Update original badge if it exists (for compatibility)
  const originalBadge = document.getElementById('notificationsBadge');
  if (originalBadge) {
    if (unreadNotifications > 0) {
      originalBadge.textContent = unreadNotifications > 99 ? '99+' : unreadNotifications;
      originalBadge.style.display = 'flex';
    } else {
      originalBadge.style.display = 'none';
    }
  }
  
  // Update sidebar toggle badge with total count
  updateSidebarToggleBadge();
}

// Update messages badge for sidebar
function updateMessagesBadge() {
  // Update sidebar messages badge
  const sidebarBadge = document.getElementById('sidebar-messagesBadge');
  
  if (sidebarBadge) {
    if (unreadMessages > 0) {
      sidebarBadge.textContent = unreadMessages > 99 ? '99+' : unreadMessages;
      sidebarBadge.style.display = 'flex';
    } else {
      sidebarBadge.style.display = 'none';
    }
  }
  
  // Update original badge if it exists (for compatibility)
  const originalBadge = document.getElementById('messagesBadge');
  if (originalBadge) {
    if (unreadMessages > 0) {
      originalBadge.textContent = unreadMessages > 99 ? '99+' : unreadMessages;
      originalBadge.style.display = 'flex';
    } else {
      originalBadge.style.display = 'none';
    }
  }
  
  // Update sidebar toggle badge with total count
  updateSidebarToggleBadge();
}

// Update sidebar toggle button badge with total notifications and messages
function updateSidebarToggleBadge() {
  const toggleBadge = document.getElementById('sidebar-toggle-badge');
  
  if (toggleBadge) {
    const totalCount = (unreadNotifications || 0) + (unreadMessages || 0);
    
    if (totalCount > 0) {
      toggleBadge.textContent = totalCount > 99 ? '99+' : totalCount;
      toggleBadge.style.display = 'flex';
    } else {
      toggleBadge.style.display = 'none';
    }
  }
}

// ربط الدوال بالنافذة العامة
window.showImageModal = showImageModal;
window.closeImageModal = closeImageModal;
window.previewBookImage = previewBookImage;
window.showAddBookModal = showAddBookModal;
window.closeAddBookModal = closeAddBookModal;

// إعداد معالج نموذج إضافة الكتاب
document.addEventListener('DOMContentLoaded', function() {
  const addBookForm = document.getElementById('addBookForm');
  if (addBookForm) {
    addBookForm.addEventListener('submit', handleAddBookSubmit);
  }
});

// Periodic sync for dynamic updates
setInterval(() => {
  if (document.getElementById('sidebar')) {
    syncSidebarElements();
  }
}, 2000);
