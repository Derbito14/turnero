const express = require('express');
const { Pool } = require('pg'); // Reemplazamos mysql2 por pg
const session = require('express-session');
const path = require('path');
const moment = require('moment');
const exceptionalUsers = new Set(['nestle', 'mondelez']);


require('moment/locale/es'); // Cargar localización en español

const app = express();
const port = process.env.PORT || 3000;

// Configuración de la base de datos PostgreSQL
const pool = new Pool({
    connectionString: 'postgresql://turnosdb_mlwb_user:VSTI551tFtj2M891Kpg712sEn2crBAtm@dpg-crh2sd5svqrc7387d9a0-a.oregon-postgres.render.com/turnosdb_mlwb',
    ssl: {
        rejectUnauthorized: false  // Cambia esta opción si tu base de datos requiere un certificado específico
    }
});

module.exports = pool;



// Conectar a la base de datos
pool.connect(err => {
    if (err) throw err;
    console.log('Conectado a la base de datos PostgreSQL.');
});

// Configuración de Express
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Configuración para servir archivos estáticos
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: 'secreto',
    resave: false,
    saveUninitialized: true
}));

// Configuración de EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Función para capitalizar el primer carácter de una cadena
function capitalizeFirstLetter(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

// Página de login
app.get('/', (req, res) => {
    res.render('login', { error: null });
});

// Ruta de login
app.post('/login', (req, res) => {
    const { username, password } = req.body;

    const query = 'SELECT * FROM usuario WHERE username = $1';
    pool.query(query, [username], (err, result) => {
        if (err) throw err;

        if (result.rows.length > 0) {
            const user = result.rows[0];

            // Comparar contraseñas en texto plano
            if (password === user.password) {
                req.session.userId = user.id;
                req.session.username = user.username; // Guardar nombre de usuario en la sesión
                res.redirect('/turnos');
            } else {
                res.render('login', { error: 'Usuario o contraseña incorrectos.' });
            }
        } else {
            res.render('login', { error: 'Usuario o contraseña incorrectos.' });
        }
    });
});

// Ruta de turnos (solo accesible si el usuario está logueado)
app.get('/turnos', (req, res) => {
    if (!req.session.userId) {
        return res.redirect('/');
    }

    const isTradeLog = req.session.username === 'tradelog';

    let startDate, endDate;

    if (isTradeLog) {
        startDate = moment().subtract(2, 'days').startOf('day');
        endDate = moment(startDate).add(7, 'days');
    } else {
        startDate = moment().add(1, 'days').startOf('day');
        endDate = moment(startDate).add(7, 'days');
    }

    let days = [];
    for (let date = startDate; date.isBefore(endDate); date.add(1, 'days')) {
        let dayType;
        const dayOfWeek = date.day();

        if (dayOfWeek === 0) {
            dayType = 'sunday';
        } else if (dayOfWeek === 6) {
            dayType = 'saturday';
        } else {
            dayType = 'weekday';
        }

        days.push({
            dayName: capitalizeFirstLetter(date.format('dddd')),
            date: date.format('DD/MM/YYYY'),
            dayType: dayType,
            index: days.length // Agrega el índice del día
        });
    }

    const queries = days.map(day => {
        const formattedDay = moment(day.date, 'DD/MM/YYYY').format('YYYY-MM-DD');
        return new Promise((resolve, reject) => {
            pool.query('SELECT * FROM reservas WHERE day = $1', [formattedDay], (err, result) => {
                if (err) return reject(err);
                resolve(result.rows);
            });
        });
    });

    Promise.all(queries)
        .then(results => {
            const reservations = results.map(res => res.reduce((acc, cur) => {
                acc[cur.hour] = cur;
                return acc;
            }, {}));
            res.render('turnos', { days: days, username: req.session.username, isTradeLog: isTradeLog, reservations: reservations });
        })
        .catch(err => {
            console.error('Error al obtener reservas:', err);
            res.status(500).send('Error al obtener reservas.');
        });
});


// Ruta para realizar la reserva
// Ruta para realizar la reserva
app.post('/reservar', async (req, res) => {
    const { day, hour, pallets, domain } = req.body;
    const username = req.session.username; // Obtener el nombre de usuario desde la sesión

    if (!req.session.userId) {
        return res.status(401).send('Usuario no autenticado.');
    }

    // Validar los datos recibidos
    if (!day || !hour || !pallets || !domain) {
        return res.status(400).send('Datos incompletos.');
    }

    // Convertir la fecha a formato PostgreSQL (yyyy-mm-dd)
    const formattedDay = moment(day, 'DD/MM/YYYY').format('YYYY-MM-DD');

    try {
        // Contar las reservas actuales del usuario para el día específico
        const reservationCountResult = await pool.query('SELECT COUNT(*) FROM reservas WHERE user_name = $1 AND day = $2', [username, formattedDay]);
        const reservationCount = parseInt(reservationCountResult.rows[0].count);


        // Establecer el límite de reservas basado en si el usuario está en la lista de excepcionales
        const limit = exceptionalUsers.has(username) ? 5 : 2;

        if (reservationCount >= limit) {

            return res.status(400).send(`Has alcanzado el límite de reservas para el día ${day}.`);
        }

        // Insertar la reserva en la base de datos
        const query = `
            INSERT INTO reservas (user_name, day, hour, pallets, domain, completed)
            VALUES ($1, $2, $3, $4, $5, $6)
        `;
        await pool.query(query, [username, formattedDay, hour, pallets, domain, 0]);

        // Reserva realizada con éxito
        res.status(200).send('Reserva realizada con éxito.');
    } catch (err) {
        console.error('Error al realizar la reserva:', err);
        res.status(500).send('Error al realizar la reserva.');
    }

});

// Ruta para obtener reservas para un día específico
app.get('/reservas', (req, res) => {
    const { date } = req.query;

    if (!date) {
        return res.status(400).send('Fecha requerida.');
    }

    const formattedDate = moment(date, 'DD/MM/YYYY').format('YYYY-MM-DD');

    const query = 'SELECT * FROM reservas WHERE day = $1';
    pool.query(query, [formattedDate], (err, result) => {
        if (err) {
            console.error('Error al obtener las reservas:', err);
            return res.status(500).send('Error al obtener reservas.');
        }

        res.json(result.rows);
    });
});

// Ruta para eliminar una reserva
app.post('/eliminar-reserva', (req, res) => {
    const { day, hour } = req.body;
    const username = req.session.username;

    if (!req.session.userId) {
        return res.status(401).send('Usuario no autenticado.');
    }

    // Validar los datos recibidos
    if (!day || !hour) {
        return res.status(400).send('Datos incompletos.');
    }

    // Convertir la fecha a formato PostgreSQL (yyyy-mm-dd)
    const formattedDay = moment(day, 'DD/MM/YYYY').format('YYYY-MM-DD');

    // Eliminar la reserva de la base de datos
    const query = `
        DELETE FROM reservas
        WHERE day = $1 AND hour = $2 AND (user_name = $3 OR $3 = 'tradelog')
    `;

    pool.query(query, [formattedDay, hour, username], (err, result) => {
        if (err) {
            console.error('Error al eliminar la reserva:', err);
            return res.status(500).send('Error al eliminar la reserva.');
        }

        // Reserva eliminada con éxito
        res.status(200).send('Reserva eliminada con éxito.');
    });
});

// Ruta de logout
app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) return res.redirect('/turnos');
        res.redirect('/');
    });
});

// Iniciar el servidor
app.listen(port, () => {
    console.log(`Servidor escuchando en http://localhost:${port}`);
});

// Ruta para marcar una reserva como completada
app.post('/check-reserva', (req, res) => {
    const { day, hour } = req.body;
    const username = req.session.username;

    if (!req.session.userId) {
        return res.status(401).send('Usuario no autenticado.');
    }

    // Validar los datos recibidos
    if (!day || !hour) {
        return res.status(400).send('Datos incompletos.');
    }

    // Convertir la fecha a formato PostgreSQL (yyyy-mm-dd)
    const formattedDay = moment(day, 'DD/MM/YYYY').format('YYYY-MM-DD');

    // Actualizar la reserva en la base de datos
    const query = `
        UPDATE reservas
        SET completed = TRUE
        WHERE day = $1 AND hour = $2 AND (user_name = $3 OR $3 = 'tradelog') AND completed = FALSE
    `;

    pool.query(query, [formattedDay, hour, username], (err, result) => {
        if (err) {
            console.error('Error al actualizar la reserva:', err);
            return res.status(500).send('Error al marcar la reserva como completada.');
        }

        // Reserva marcada como completada con éxito
        res.status(200).send('Reserva marcada como completada.');
    });
});

// Ruta para exportar reservas a Excel
app.get('/exportar-reservas', (req, res) => {
    if (req.session.username !== 'tradelog') {
        return res.status(403).send('No tienes permiso para acceder a esta función.');
    }

    const today = moment().format('YYYY-MM-DD');
    const startDate = moment().subtract(30, 'days').format('YYYY-MM-DD'); // Ajusta el rango según tus necesidades

    const query = `
        SELECT * FROM reservas
        WHERE day BETWEEN $1 AND $2
    `;

    pool.query(query, [startDate, today], (err, result) => {
        if (err) {
            console.error('Error al obtener reservas:', err);
            return res.status(500).send('Error al obtener reservas.');
        }

        const reservations = result.rows.map(reservation => ({
            day: reservation.day,
            hour: reservation.hour,
            pallets: reservation.pallets,
            domain: reservation.domain,
            user_name: reservation.user_name,
            completed: reservation.completed ? 'Sí' : 'No'
        }));

        res.json(reservations);
    });
});
